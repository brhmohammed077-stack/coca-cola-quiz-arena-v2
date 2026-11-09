-- Coca-Cola Quiz Arena: isolated multiplayer schema.
-- This migration intentionally uses arena_* names and does not alter legacy tables.

create table if not exists public.arena_matches (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null default 'Coca-Cola Quiz Arena',
  status text not null default 'lobby' check (status in ('lobby','countdown','buzz','answer','question_done','finished')),
  round_number integer not null default 1 check (round_number >= 1),
  current_question_id uuid,
  countdown_ends_at timestamptz,
  buzz_open_until timestamptz,
  answer_deadline timestamptz,
  active_queue_id bigint,
  fill_percent numeric(5,2) not null default 0 check (fill_percent between 0 and 100),
  host_code_salt text not null,
  host_code_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.arena_teams (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.arena_matches(id) on delete cascade,
  team_number integer not null check (team_number between 1 and 10),
  display_name text not null,
  code_salt text not null,
  code_hash text not null,
  score integer not null default 0,
  created_at timestamptz not null default now(),
  unique(match_id, team_number),
  unique(match_id, id)
);

create table if not exists public.arena_questions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.arena_matches(id) on delete cascade,
  question_order integer not null,
  prompt text not null,
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 6),
  correct_option smallint not null check (correct_option between 0 and 5),
  created_at timestamptz not null default now(),
  unique(match_id, question_order),
  unique(match_id, id)
);

alter table public.arena_matches
  drop constraint if exists arena_matches_current_question_fk;
alter table public.arena_matches
  add constraint arena_matches_current_question_fk
  foreign key (id, current_question_id)
  references public.arena_questions(match_id, id)
  deferrable initially deferred;

create table if not exists public.arena_buzz_queue (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.arena_matches(id) on delete cascade,
  question_id uuid not null references public.arena_questions(id) on delete cascade,
  team_id uuid not null references public.arena_teams(id) on delete cascade,
  pressed_at timestamptz not null default clock_timestamp(),
  answered_at timestamptz,
  answer_option smallint check (answer_option between 0 and 5),
  result text check (result in ('correct','wrong','timeout')),
  unique(question_id, team_id)
);

create index if not exists arena_buzz_queue_turn_idx
  on public.arena_buzz_queue(match_id, question_id, id) where result is null;
create index if not exists arena_teams_match_idx on public.arena_teams(match_id, team_number);

alter table public.arena_matches enable row level security;
alter table public.arena_teams enable row level security;
alter table public.arena_questions enable row level security;
alter table public.arena_buzz_queue enable row level security;

revoke all on public.arena_matches, public.arena_teams, public.arena_questions, public.arena_buzz_queue from public, anon, authenticated;
grant all on public.arena_matches, public.arena_teams, public.arena_questions, public.arena_buzz_queue to service_role;
grant usage, select on sequence public.arena_buzz_queue_id_seq to service_role;

create or replace function public.arena_bootstrap(
  p_slug text, p_title text, p_host_salt text, p_host_hash text, p_teams jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_match_id uuid; v_team jsonb;
begin
  if exists (select 1 from public.arena_matches where slug = p_slug) then
    raise exception 'A match with this slug already exists';
  end if;
  if jsonb_typeof(p_teams) <> 'array' or jsonb_array_length(p_teams) <> 10 then
    raise exception 'Exactly 10 teams are required';
  end if;
  insert into public.arena_matches(slug,title,host_code_salt,host_code_hash)
    values (p_slug,p_title,p_host_salt,p_host_hash) returning id into v_match_id;
  for v_team in select value from jsonb_array_elements(p_teams) loop
    insert into public.arena_teams(match_id,team_number,display_name,code_salt,code_hash)
      values (v_match_id,(v_team->>'team_number')::int,v_team->>'display_name',v_team->>'code_salt',v_team->>'code_hash');
  end loop;
  return v_match_id;
end; $$;

create or replace function public.arena_start_question(
  p_match_id uuid, p_prompt text, p_options jsonb, p_correct_option smallint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_match public.arena_matches%rowtype; v_question_id uuid; v_count integer;
begin
  select * into v_match from public.arena_matches where id=p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  if v_match.status not in ('lobby','question_done') then raise exception 'The current round is still active'; end if;
  if length(trim(p_prompt))=0 or jsonb_typeof(p_options)<>'array' or jsonb_array_length(p_options)<>6 or p_correct_option not between 0 and 5 then
    raise exception 'Question must contain text and exactly six options';
  end if;
  insert into public.arena_questions(match_id,question_order,prompt,options,correct_option)
    values (p_match_id,v_match.round_number,trim(p_prompt),p_options,p_correct_option)
    on conflict (match_id,question_order) do update set prompt=excluded.prompt, options=excluded.options, correct_option=excluded.correct_option
    returning id into v_question_id;
  delete from public.arena_buzz_queue where question_id=v_question_id;
  update public.arena_matches set current_question_id=v_question_id,status='countdown',
    countdown_ends_at=now()+interval '3 seconds', buzz_open_until=now()+interval '11 seconds',
    answer_deadline=null,active_queue_id=null,updated_at=now()
    where id=p_match_id;
  return jsonb_build_object('question_id',v_question_id,'round_number',v_match.round_number);
end; $$;

create or replace function public.arena_advance_turn(p_match_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_match public.arena_matches%rowtype; v_queue_id bigint; v_deadline timestamptz;
begin
  select * into v_match from public.arena_matches where id=p_match_id for update;
  if not found or v_match.current_question_id is null then return; end if;
  select id into v_queue_id from public.arena_buzz_queue
    where match_id=p_match_id and question_id=v_match.current_question_id and result is null
    order by id limit 1;
  if v_queue_id is not null then
    update public.arena_matches set status='answer',active_queue_id=v_queue_id,
      answer_deadline=now()+interval '5 seconds',updated_at=now() where id=p_match_id;
  elsif v_match.buzz_open_until is not null and now()<v_match.buzz_open_until then
    update public.arena_matches set status='buzz',active_queue_id=null,answer_deadline=null,updated_at=now() where id=p_match_id;
  else
    update public.arena_matches set status='question_done',active_queue_id=null,answer_deadline=null,updated_at=now() where id=p_match_id;
  end if;
end; $$;

create or replace function public.arena_register_buzz(p_match_id uuid,p_team_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_match public.arena_matches%rowtype; v_id bigint; v_position integer;
begin
  select * into v_match from public.arena_matches where id=p_match_id for update;
  if not found or v_match.current_question_id is null then raise exception 'No active question'; end if;
  if v_match.status='countdown' and now()>=v_match.countdown_ends_at then
    update public.arena_matches set status='buzz',updated_at=now() where id=p_match_id;
    v_match.status:='buzz';
  end if;
  if v_match.status not in ('buzz','answer') or v_match.buzz_open_until is null or now()>v_match.buzz_open_until then
    raise exception 'The buzzer is closed';
  end if;
  if not exists(select 1 from public.arena_teams where id=p_team_id and match_id=p_match_id) then raise exception 'Invalid team'; end if;
  insert into public.arena_buzz_queue(match_id,question_id,team_id)
    values(p_match_id,v_match.current_question_id,p_team_id)
    on conflict(question_id,team_id) do nothing returning id into v_id;
  if v_id is null then raise exception 'This team has already pressed'; end if;
  select count(*) into v_position from public.arena_buzz_queue
    where question_id=v_match.current_question_id and id<=v_id;
  if v_match.status='buzz' then perform public.arena_advance_turn(p_match_id); end if;
  return jsonb_build_object('queue_id',v_id,'position',v_position);
end; $$;

create or replace function public.arena_submit_answer(p_match_id uuid,p_team_id uuid,p_answer_option smallint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_match public.arena_matches%rowtype; v_queue public.arena_buzz_queue%rowtype; v_correct smallint; v_result text;
begin
  if p_answer_option not between 0 and 5 then raise exception 'Invalid answer option'; end if;
  select * into v_match from public.arena_matches where id=p_match_id for update;
  if not found or v_match.status<>'answer' or v_match.active_queue_id is null then raise exception 'It is not this team''s turn'; end if;
  if v_match.answer_deadline is null or now()>v_match.answer_deadline then raise exception 'The answer time has expired'; end if;
  select * into v_queue from public.arena_buzz_queue where id=v_match.active_queue_id for update;
  if not found or v_queue.team_id<>p_team_id or v_queue.result is not null then raise exception 'It is not this team''s turn'; end if;
  select correct_option into v_correct from public.arena_questions where id=v_match.current_question_id;
  v_result:=case when p_answer_option=v_correct then 'correct' else 'wrong' end;
  update public.arena_buzz_queue set answer_option=p_answer_option,result=v_result,answered_at=now() where id=v_queue.id;
  if v_result='correct' then
    update public.arena_teams set score=score+10 where id=p_team_id;
    update public.arena_matches set fill_percent=least(100,fill_percent+5) where id=p_match_id;
  end if;
  perform public.arena_advance_turn(p_match_id);
  return jsonb_build_object('result',v_result);
end; $$;

create or replace function public.arena_sync(p_match_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_match public.arena_matches%rowtype;
begin
  select * into v_match from public.arena_matches where id=p_match_id for update;
  if not found or v_match.current_question_id is null then return; end if;
  if v_match.status='countdown' and v_match.countdown_ends_at<=now() then
    update public.arena_matches set status='buzz',updated_at=now() where id=p_match_id;
    v_match.status:='buzz';
  end if;
  if v_match.status='answer' and v_match.answer_deadline<=now() and v_match.active_queue_id is not null then
    update public.arena_buzz_queue set result='timeout',answered_at=now()
      where id=v_match.active_queue_id and result is null;
    perform public.arena_advance_turn(p_match_id);
  elsif v_match.status='buzz' then
    perform public.arena_advance_turn(p_match_id);
  end if;
end; $$;

create or replace function public.arena_next_question(p_match_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.arena_matches where id=p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  if v_status not in ('question_done','lobby') then raise exception 'Finish the current question first'; end if;
  update public.arena_matches set round_number=round_number+1,status='lobby',current_question_id=null,
    countdown_ends_at=null,buzz_open_until=null,answer_deadline=null,active_queue_id=null,updated_at=now()
    where id=p_match_id;
end; $$;

create or replace function public.arena_reset(p_match_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.arena_matches where id=p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  delete from public.arena_buzz_queue where match_id=p_match_id;
  update public.arena_teams set score=0 where match_id=p_match_id;
  update public.arena_matches set status='lobby',round_number=1,current_question_id=null,
    countdown_ends_at=null,buzz_open_until=null,answer_deadline=null,active_queue_id=null,
    fill_percent=0,updated_at=now() where id=p_match_id;
end; $$;

revoke all on function public.arena_bootstrap(text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.arena_start_question(uuid,text,jsonb,smallint) from public,anon,authenticated;
revoke all on function public.arena_advance_turn(uuid) from public,anon,authenticated;
revoke all on function public.arena_register_buzz(uuid,uuid) from public,anon,authenticated;
revoke all on function public.arena_submit_answer(uuid,uuid,smallint) from public,anon,authenticated;
revoke all on function public.arena_sync(uuid) from public,anon,authenticated;
revoke all on function public.arena_next_question(uuid) from public,anon,authenticated;
revoke all on function public.arena_reset(uuid) from public,anon,authenticated;
grant execute on function public.arena_bootstrap(text,text,text,text,jsonb) to service_role;
grant execute on function public.arena_start_question(uuid,text,jsonb,smallint) to service_role;
grant execute on function public.arena_advance_turn(uuid) to service_role;
grant execute on function public.arena_register_buzz(uuid,uuid) to service_role;
grant execute on function public.arena_submit_answer(uuid,uuid,smallint) to service_role;
grant execute on function public.arena_sync(uuid) to service_role;
grant execute on function public.arena_next_question(uuid) to service_role;
grant execute on function public.arena_reset(uuid) to service_role;

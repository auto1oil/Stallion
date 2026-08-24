-- ==========================================================================
-- 31. Messaging — boards, membership, messages, read state, avatars
-- ==========================================================================
-- A lightweight message-board + DM system that mirrors the notification bell:
-- the top-bar message bubble shows an unread red badge and fires a Web Push
-- when the app is closed. Read state is tracked per (board, user) via
-- last_read_at; the UI shows a small avatar for each member who has read up to
-- a given message (profile photo, or initials when none is uploaded).
--
-- Boards:
--   * all_staff = true  -> the default staff board: every staff user can see
--                          and post; no explicit membership row needed.
--   * all_staff = false -> an extra board (multi-board mode) or a DM. Access is
--                          by explicit board_members rows. Admins add/remove.
--   * kind = 'dm'       -> a 1:1 direct thread (customer<->rep, staff<->staff).
--
-- board_members rows double as read-state (last_read_at) and are created
-- lazily when a user first opens a board, even on all_staff boards.

alter table public.profiles
  add column if not exists avatar_url text,
  add column if not exists message_alert_mode text not null default 'sound'
    check (message_alert_mode in ('sound', 'vibrate', 'silent'));

create table if not exists public.message_boards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'board' check (kind in ('board', 'dm')),
  all_staff   boolean not null default false,
  is_default  boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null
);
create index if not exists message_boards_sort_idx on public.message_boards(sort_order);

create table if not exists public.board_members (
  board_id     uuid not null references public.message_boards(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  added_by     uuid references public.profiles(id) on delete set null,
  last_read_at timestamptz,
  created_at   timestamptz not null default now(),
  primary key (board_id, user_id)
);
create index if not exists board_members_user_idx on public.board_members(user_id);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.message_boards(id) on delete cascade,
  sender_id  uuid references public.profiles(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_board_idx on public.messages(board_id, created_at);

-- Can the current user see / post to this board?
create or replace function public.can_access_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.message_boards mb
    where mb.id = b
      and (
        (mb.all_staff and public.is_staff())
        or exists (select 1 from public.board_members m
                   where m.board_id = b and m.user_id = auth.uid())
      )
  );
$$;
grant execute on function public.can_access_board(uuid) to authenticated;

-- Seed the default staff board once.
insert into public.message_boards (name, kind, all_staff, is_default, sort_order)
select 'Team', 'board', true, true, 0
where not exists (select 1 from public.message_boards where is_default);

grant select, insert, update, delete on public.message_boards to authenticated;
grant select, insert, update, delete on public.board_members to authenticated;
grant select, insert, update, delete on public.messages to authenticated;

alter table public.message_boards enable row level security;
alter table public.board_members enable row level security;
alter table public.messages enable row level security;

-- Boards: readable if accessible; admins manage everything; anyone may create
-- a DM board (the ensure_dm RPC enforces who can DM whom).
drop policy if exists "boards read"      on public.message_boards;
drop policy if exists "boards admin all" on public.message_boards;
drop policy if exists "boards dm create" on public.message_boards;
create policy "boards read" on public.message_boards for select to authenticated
  using (public.can_access_board(id));
create policy "boards admin all" on public.message_boards for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "boards dm create" on public.message_boards for insert to authenticated
  with check (kind = 'dm' and not all_staff and not is_default);

-- Members: readable by anyone who can access the board. A user manages their
-- OWN row (joining DMs + saving read-state). Admins add/remove anyone.
drop policy if exists "members read"        on public.board_members;
drop policy if exists "members self insert" on public.board_members;
drop policy if exists "members self update" on public.board_members;
drop policy if exists "members admin all"   on public.board_members;
create policy "members read" on public.board_members for select to authenticated
  using (public.can_access_board(board_id));
create policy "members self insert" on public.board_members for insert to authenticated
  with check (user_id = auth.uid() and public.can_access_board(board_id));
create policy "members self update" on public.board_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "members admin all" on public.board_members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Messages: read/post if you can access the board; only admins delete.
drop policy if exists "messages read"         on public.messages;
drop policy if exists "messages send"         on public.messages;
drop policy if exists "messages admin delete" on public.messages;
create policy "messages read" on public.messages for select to authenticated
  using (public.can_access_board(board_id));
create policy "messages send" on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.can_access_board(board_id));
create policy "messages admin delete" on public.messages for delete to authenticated
  using (public.is_admin());

-- Find-or-create a 1:1 DM between the caller and `other`. Customers may DM
-- staff (and vice-versa); customer<->customer is rejected.
create or replace function public.ensure_dm(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
  me  uuid := auth.uid();
begin
  if me is null or other is null or me = other then
    raise exception 'invalid dm';
  end if;
  if not (
        public.is_staff()
        or exists (select 1 from public.profiles
                   where id = other and role in ('salesman','driver','admin','master_admin'))
     ) then
    raise exception 'not allowed';
  end if;

  select mb.id into bid
    from public.message_boards mb
   where mb.kind = 'dm'
     and (select count(*) from public.board_members m where m.board_id = mb.id) = 2
     and exists (select 1 from public.board_members m where m.board_id = mb.id and m.user_id = me)
     and exists (select 1 from public.board_members m where m.board_id = mb.id and m.user_id = other)
   limit 1;
  if bid is not null then return bid; end if;

  insert into public.message_boards (name, kind, all_staff, created_by)
    values ('Direct message', 'dm', false, me) returning id into bid;
  insert into public.board_members (board_id, user_id, added_by)
    values (bid, me, me), (bid, other, me);
  return bid;
end;
$$;
grant execute on function public.ensure_dm(uuid) to authenticated;

-- Avatars: a public bucket; each user writes only under their own uid/ prefix.
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;
drop policy if exists "avatars public read" on storage.objects;
drop policy if exists "avatars self write"  on storage.objects;
create policy "avatars public read" on storage.objects for select
  using (bucket_id = 'avatars');
create policy "avatars self write" on storage.objects for all to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Web Push for a new message: one POST per recipient (so each honors their own
-- alert mode), pointing at the right route for their role. Fire-and-forget.
create or replace function public.dispatch_push_for_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  endpoint     text;
  secret       text;
  sender_label text;
  rec          record;
  subs         jsonb;
begin
  select value into endpoint from public.app_settings where key = 'push_dispatch_url';
  select value into secret   from public.app_settings where key = 'push_dispatch_secret';
  if endpoint is null or endpoint = '' then return new; end if;

  select coalesce(full_name, email) into sender_label
    from public.profiles where id = new.sender_id;

  for rec in
    select p.id, p.role, p.message_alert_mode as mode
      from public.message_boards mb
      join public.profiles p on (
        (mb.all_staff and p.role in ('salesman','driver','admin','master_admin'))
        or p.id in (select user_id from public.board_members where board_id = mb.id)
      )
     where mb.id = new.board_id and p.id <> new.sender_id
  loop
    select jsonb_agg(jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
      into subs from public.push_subscriptions ps where ps.user_id = rec.id;
    if subs is null then continue; end if;

    perform net.http_post(
      url     := endpoint,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', coalesce(secret, '')),
      body    := jsonb_build_object(
        'subscriptions', subs,
        'payload', jsonb_build_object(
          'title',   coalesce(sender_label, 'New message'),
          'body',    left(new.body, 140),
          'url',     case when rec.role = 'customer' then '/shop/messages?b=' else '/messages?b=' end || new.board_id,
          'tag',     'msg-' || new.board_id,
          'silent',  (rec.mode = 'silent'),
          'vibrate', (rec.mode = 'vibrate')
        )
      )
    );
  end loop;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_dispatch_push_message on public.messages;
create trigger trg_dispatch_push_message
  after insert on public.messages
  for each row execute function public.dispatch_push_for_message();



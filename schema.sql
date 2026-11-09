create table public.roles(id text primary key,name text not null,rank int not null default 99,can_edit boolean not null default false);
create table public.profiles(id uuid primary key references auth.users on delete cascade,name text,role_id text references public.roles(id) on delete set null);
create table public.site(id text primary key,data jsonb not null default '{}');
insert into public.roles values('founder','Founder',1,true),('developer','Developer',2,true),('builder','Builder',3,false);
insert into public.site values('main','{"tagline":"Server Minecraft komunitas"}');

create function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into public.profiles(id,name) values(new.id,coalesce(nullif(new.raw_user_meta_data->>'name',''),new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'preferred_username',split_part(new.email,'@',1))); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create function public.is_founder() returns boolean language sql security definer stable set search_path=public as $$
select exists(select 1 from profiles where id=auth.uid() and role_id='founder') $$;
create function public.is_editor() returns boolean language sql security definer stable set search_path=public as $$
select exists(select 1 from profiles p join roles r on r.id=p.role_id where p.id=auth.uid() and r.can_edit) $$;

alter table public.roles enable row level security;
alter table public.profiles enable row level security;
alter table public.site enable row level security;

create policy roles_read on public.roles for select using(true);
create policy roles_ins on public.roles for insert with check(public.is_founder());
create policy roles_upd on public.roles for update using(public.is_founder()) with check(public.is_founder());
create policy roles_del on public.roles for delete using(public.is_founder() and id<>'founder');
create policy prof_read on public.profiles for select using(true);
create policy prof_upd on public.profiles for update using(public.is_founder()) with check(public.is_founder());
create policy site_read on public.site for select using(true);
create policy site_ins on public.site for insert with check(public.is_editor());
create policy site_upd on public.site for update using(public.is_editor()) with check(public.is_editor());

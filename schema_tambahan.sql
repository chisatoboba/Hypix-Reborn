-- Jalankan SETELAH schema.sql, di Supabase > SQL Editor.

-- 1) Buat profil untuk akun yang sudah ada sebelum trigger dibuat
insert into public.profiles(id,name)
select id, coalesce(nullif(raw_user_meta_data->>'name',''),raw_user_meta_data->>'full_name',split_part(email,'@',1))
from auth.users on conflict (id) do nothing;

-- 2) Jadikan akunmu Founder (ganti emailnya). Tanpa ini tidak ada yang bisa edit website.
update public.profiles set role_id='founder'
where id=(select id from auth.users where email='GANTI_DENGAN_EMAILMU');

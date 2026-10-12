-- D3b — the capability grant count
-- REQUIRES: 004   (reads role_capabilities, which 004 creates)
--
-- Split out of did-it-apply.sql, which is written for a database that may
-- still be at 002. A single file cannot declare two different requirements,
-- and one query needing a later migration is exactly how 057 failed on
-- production: the file was fine, one assertion inside it was not.
--
-- Run only once D3 reports APPLIED. Expect ~78-79 grants across 7 roles.

select count(*)              as capability_grants,
       count(distinct role)  as roles_granted,
       string_agg(distinct role, ', ' order by role) as roles
from role_capabilities;

-- ═══════════════════════════════════════════════════════════════════════════
-- 094 — every country, not the eleven somebody thought of
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Apply to store-ops-uat and production (KindOS).
--
-- REQUIRES: 038   (nationalities and bill_nationalities)
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- The list was eleven countries plus "Other". A shop on Charoen Krung
-- serves more than eleven nationalities, and "Other" is where the answer
-- goes to die — a count of 30 "Other" tells nobody anything, and the KA
-- who served a Dutch customer has no way to say so.
--
-- ── EXISTING CODES SURVIVE, AND THAT IS THE WHOLE CONSTRAINT ──────────────
--
-- `bill_nationalities.nationality` and `customer_feedback.nationality`
-- already hold `thailand` and `china`. The codes are snake_case English
-- names, not ISO — a choice made before this and not worth breaking now.
--
-- So the eleven that exist KEEP THEIR CODES, and the other 187 follow the
-- same convention. `on conflict (code) do update` touches only the label
-- and the sort order, never the code, so no saved row is orphaned. The
-- alternative — renaming to ISO — would have been a migration that
-- silently unlinked two tables from their vocabulary, which is the
-- `services.name` lesson in a different hat.
--
-- ── WHAT IS NOT OFFERED FOR A COUNT ───────────────────────────────────────
--
-- `offer_in_counts` already existed and already excluded `unknown` and
-- `unrecorded`. Those stay excluded: a KA counting bills by country is
-- recording what they SAW, and "unknown" is not something you see. At a
-- POS branch the screen works out how many imported bills have a country
-- and how many do not — derived, never keyed, because the import already
-- knows and a second answer would be free to drift.
--
-- `Other` stays offered. A customer from somewhere not on a list of 198
-- is a real answer and better than an abandoned row.

begin;

-- ── STEP 1 ────────────────────────────────────────────────────────────────

insert into nationalities (code, label, sort_order, active, offer_in_counts)
values
  ('afghanistan', 'Afghanistan', 10, true, true),
  ('albania', 'Albania', 20, true, true),
  ('algeria', 'Algeria', 30, true, true),
  ('andorra', 'Andorra', 40, true, true),
  ('angola', 'Angola', 50, true, true),
  ('antigua_barbuda', 'Antigua & Barbuda', 60, true, true),
  ('argentina', 'Argentina', 70, true, true),
  ('armenia', 'Armenia', 80, true, true),
  ('australia', 'Australia', 90, true, true),
  ('austria', 'Austria', 100, true, true),
  ('azerbaijan', 'Azerbaijan', 110, true, true),
  ('bahamas', 'Bahamas', 120, true, true),
  ('bahrain', 'Bahrain', 130, true, true),
  ('bangladesh', 'Bangladesh', 140, true, true),
  ('barbados', 'Barbados', 150, true, true),
  ('belarus', 'Belarus', 160, true, true),
  ('belgium', 'Belgium', 170, true, true),
  ('belize', 'Belize', 180, true, true),
  ('benin', 'Benin', 190, true, true),
  ('bhutan', 'Bhutan', 200, true, true),
  ('bolivia', 'Bolivia', 210, true, true),
  ('bosnia_herzegovina', 'Bosnia & Herzegovina', 220, true, true),
  ('botswana', 'Botswana', 230, true, true),
  ('brazil', 'Brazil', 240, true, true),
  ('brunei', 'Brunei', 250, true, true),
  ('bulgaria', 'Bulgaria', 260, true, true),
  ('burkina_faso', 'Burkina Faso', 270, true, true),
  ('burundi', 'Burundi', 280, true, true),
  ('cambodia', 'Cambodia', 290, true, true),
  ('cameroon', 'Cameroon', 300, true, true),
  ('canada', 'Canada', 310, true, true),
  ('cape_verde', 'Cape Verde', 320, true, true),
  ('central_african_republic', 'Central African Republic', 330, true, true),
  ('chad', 'Chad', 340, true, true),
  ('chile', 'Chile', 350, true, true),
  ('china', 'China', 360, true, true),
  ('colombia', 'Colombia', 370, true, true),
  ('comoros', 'Comoros', 380, true, true),
  ('congo_brazzaville', 'Congo - Brazzaville', 390, true, true),
  ('congo_kinshasa', 'Congo - Kinshasa', 400, true, true),
  ('costa_rica', 'Costa Rica', 410, true, true),
  ('c_te_d_ivoire', 'Côte d’Ivoire', 420, true, true),
  ('croatia', 'Croatia', 430, true, true),
  ('cuba', 'Cuba', 440, true, true),
  ('cyprus', 'Cyprus', 450, true, true),
  ('czechia', 'Czechia', 460, true, true),
  ('denmark', 'Denmark', 470, true, true),
  ('djibouti', 'Djibouti', 480, true, true),
  ('dominica', 'Dominica', 490, true, true),
  ('dominican_republic', 'Dominican Republic', 500, true, true),
  ('ecuador', 'Ecuador', 510, true, true),
  ('egypt', 'Egypt', 520, true, true),
  ('el_salvador', 'El Salvador', 530, true, true),
  ('equatorial_guinea', 'Equatorial Guinea', 540, true, true),
  ('eritrea', 'Eritrea', 550, true, true),
  ('estonia', 'Estonia', 560, true, true),
  ('eswatini', 'Eswatini', 570, true, true),
  ('ethiopia', 'Ethiopia', 580, true, true),
  ('fiji', 'Fiji', 590, true, true),
  ('finland', 'Finland', 600, true, true),
  ('france', 'France', 610, true, true),
  ('gabon', 'Gabon', 620, true, true),
  ('gambia', 'Gambia', 630, true, true),
  ('georgia', 'Georgia', 640, true, true),
  ('germany', 'Germany', 650, true, true),
  ('ghana', 'Ghana', 660, true, true),
  ('greece', 'Greece', 670, true, true),
  ('grenada', 'Grenada', 680, true, true),
  ('guatemala', 'Guatemala', 690, true, true),
  ('guinea', 'Guinea', 700, true, true),
  ('guinea_bissau', 'Guinea-Bissau', 710, true, true),
  ('guyana', 'Guyana', 720, true, true),
  ('haiti', 'Haiti', 730, true, true),
  ('honduras', 'Honduras', 740, true, true),
  ('hong_kong', 'Hong Kong SAR China', 750, true, true),
  ('hungary', 'Hungary', 760, true, true),
  ('iceland', 'Iceland', 770, true, true),
  ('india', 'India', 780, true, true),
  ('indonesia', 'Indonesia', 790, true, true),
  ('iran', 'Iran', 800, true, true),
  ('iraq', 'Iraq', 810, true, true),
  ('ireland', 'Ireland', 820, true, true),
  ('israel', 'Israel', 830, true, true),
  ('italy', 'Italy', 840, true, true),
  ('jamaica', 'Jamaica', 850, true, true),
  ('japan', 'Japan', 860, true, true),
  ('jordan', 'Jordan', 870, true, true),
  ('kazakhstan', 'Kazakhstan', 880, true, true),
  ('kenya', 'Kenya', 890, true, true),
  ('kiribati', 'Kiribati', 900, true, true),
  ('kuwait', 'Kuwait', 910, true, true),
  ('kyrgyzstan', 'Kyrgyzstan', 920, true, true),
  ('laos', 'Laos', 930, true, true),
  ('latvia', 'Latvia', 940, true, true),
  ('lebanon', 'Lebanon', 950, true, true),
  ('lesotho', 'Lesotho', 960, true, true),
  ('liberia', 'Liberia', 970, true, true),
  ('libya', 'Libya', 980, true, true),
  ('liechtenstein', 'Liechtenstein', 990, true, true),
  ('lithuania', 'Lithuania', 1000, true, true),
  ('luxembourg', 'Luxembourg', 1010, true, true),
  ('macao_sar_china', 'Macao SAR China', 1020, true, true),
  ('madagascar', 'Madagascar', 1030, true, true),
  ('malawi', 'Malawi', 1040, true, true),
  ('malaysia', 'Malaysia', 1050, true, true),
  ('maldives', 'Maldives', 1060, true, true),
  ('mali', 'Mali', 1070, true, true),
  ('malta', 'Malta', 1080, true, true),
  ('marshall_islands', 'Marshall Islands', 1090, true, true),
  ('mauritania', 'Mauritania', 1100, true, true),
  ('mauritius', 'Mauritius', 1110, true, true),
  ('mexico', 'Mexico', 1120, true, true),
  ('micronesia', 'Micronesia', 1130, true, true),
  ('moldova', 'Moldova', 1140, true, true),
  ('monaco', 'Monaco', 1150, true, true),
  ('mongolia', 'Mongolia', 1160, true, true),
  ('montenegro', 'Montenegro', 1170, true, true),
  ('morocco', 'Morocco', 1180, true, true),
  ('mozambique', 'Mozambique', 1190, true, true),
  ('myanmar_burma', 'Myanmar (Burma)', 1200, true, true),
  ('namibia', 'Namibia', 1210, true, true),
  ('nauru', 'Nauru', 1220, true, true),
  ('nepal', 'Nepal', 1230, true, true),
  ('netherlands', 'Netherlands', 1240, true, true),
  ('new_zealand', 'New Zealand', 1250, true, true),
  ('nicaragua', 'Nicaragua', 1260, true, true),
  ('niger', 'Niger', 1270, true, true),
  ('nigeria', 'Nigeria', 1280, true, true),
  ('north_korea', 'North Korea', 1290, true, true),
  ('north_macedonia', 'North Macedonia', 1300, true, true),
  ('norway', 'Norway', 1310, true, true),
  ('oman', 'Oman', 1320, true, true),
  ('pakistan', 'Pakistan', 1330, true, true),
  ('palau', 'Palau', 1340, true, true),
  ('panama', 'Panama', 1350, true, true),
  ('papua_new_guinea', 'Papua New Guinea', 1360, true, true),
  ('paraguay', 'Paraguay', 1370, true, true),
  ('peru', 'Peru', 1380, true, true),
  ('philippines', 'Philippines', 1390, true, true),
  ('poland', 'Poland', 1400, true, true),
  ('portugal', 'Portugal', 1410, true, true),
  ('puerto_rico', 'Puerto Rico', 1420, true, true),
  ('qatar', 'Qatar', 1430, true, true),
  ('romania', 'Romania', 1440, true, true),
  ('russia', 'Russia', 1450, true, true),
  ('rwanda', 'Rwanda', 1460, true, true),
  ('samoa', 'Samoa', 1470, true, true),
  ('san_marino', 'San Marino', 1480, true, true),
  ('s_o_tom_pr_ncipe', 'São Tomé & Príncipe', 1490, true, true),
  ('saudi_arabia', 'Saudi Arabia', 1500, true, true),
  ('senegal', 'Senegal', 1510, true, true),
  ('serbia', 'Serbia', 1520, true, true),
  ('seychelles', 'Seychelles', 1530, true, true),
  ('sierra_leone', 'Sierra Leone', 1540, true, true),
  ('singapore', 'Singapore', 1550, true, true),
  ('slovakia', 'Slovakia', 1560, true, true),
  ('slovenia', 'Slovenia', 1570, true, true),
  ('solomon_islands', 'Solomon Islands', 1580, true, true),
  ('somalia', 'Somalia', 1590, true, true),
  ('south_africa', 'South Africa', 1600, true, true),
  ('south_korea', 'South Korea', 1610, true, true),
  ('south_sudan', 'South Sudan', 1620, true, true),
  ('spain', 'Spain', 1630, true, true),
  ('sri_lanka', 'Sri Lanka', 1640, true, true),
  ('st_kitts_nevis', 'St. Kitts & Nevis', 1650, true, true),
  ('st_lucia', 'St. Lucia', 1660, true, true),
  ('st_vincent_grenadines', 'St. Vincent & Grenadines', 1670, true, true),
  ('sudan', 'Sudan', 1680, true, true),
  ('suriname', 'Suriname', 1690, true, true),
  ('sweden', 'Sweden', 1700, true, true),
  ('switzerland', 'Switzerland', 1710, true, true),
  ('syria', 'Syria', 1720, true, true),
  ('taiwan', 'Taiwan', 1730, true, true),
  ('tajikistan', 'Tajikistan', 1740, true, true),
  ('tanzania', 'Tanzania', 1750, true, true),
  ('thailand', 'Thailand', 1760, true, true),
  ('timor_leste', 'Timor-Leste', 1770, true, true),
  ('togo', 'Togo', 1780, true, true),
  ('tonga', 'Tonga', 1790, true, true),
  ('trinidad_tobago', 'Trinidad & Tobago', 1800, true, true),
  ('tunisia', 'Tunisia', 1810, true, true),
  ('t_rkiye', 'Türkiye', 1820, true, true),
  ('turkmenistan', 'Turkmenistan', 1830, true, true),
  ('tuvalu', 'Tuvalu', 1840, true, true),
  ('uganda', 'Uganda', 1850, true, true),
  ('ukraine', 'Ukraine', 1860, true, true),
  ('united_arab_emirates', 'United Arab Emirates', 1870, true, true),
  ('united_kingdom', 'United Kingdom', 1880, true, true),
  ('united_states', 'United States', 1890, true, true),
  ('uruguay', 'Uruguay', 1900, true, true),
  ('uzbekistan', 'Uzbekistan', 1910, true, true),
  ('vanuatu', 'Vanuatu', 1920, true, true),
  ('vatican_city', 'Vatican City', 1930, true, true),
  ('venezuela', 'Venezuela', 1940, true, true),
  ('vietnam', 'Vietnam', 1950, true, true),
  ('yemen', 'Yemen', 1960, true, true),
  ('zambia', 'Zambia', 1970, true, true),
  ('zimbabwe', 'Zimbabwe', 1980, true, true)
on conflict (code) do update
  set label = excluded.label,
      sort_order = excluded.sort_order,
      active = true;

-- The three that are not countries keep their place at the end and their
-- existing offer_in_counts. Re-stated rather than assumed: 004-era rows
-- have been re-seeded by a rebuild before.
insert into nationalities (code, label, sort_order, active, offer_in_counts) values
  ('other',      'Other',               9000, true,  true),
  ('unknown',    'Unknown / not asked', 9100, true,  false),
  ('unrecorded', 'Not recorded',        9200, false, false)
on conflict (code) do update
  set label = excluded.label, sort_order = excluded.sort_order,
      active = excluded.active, offer_in_counts = excluded.offer_in_counts;

commit;

-- ── STEP 2 — verify ───────────────────────────────────────────────────────
do $$
declare v_n int; v_lost int;
begin
  select count(*) into v_n from nationalities where offer_in_counts and active;
  raise notice '% | the count list is the full world (%)', v_n > 190, v_n;

  -- The constraint that matters: nothing saved was orphaned. A code that
  -- disappeared would leave a row pointing at a vocabulary entry that no
  -- longer exists, and the screen would render a blank where a country was.
  select count(*) into v_lost from (
    select nationality from bill_nationalities
    union select nationality from customer_feedback where nationality is not null) u
   where not exists (select 1 from nationalities n where n.code = u.nationality);
  raise notice '% | every saved country still resolves (% orphaned)', v_lost = 0, v_lost;

  raise notice '% | Thailand kept its code',
    exists (select 1 from nationalities where code = 'thailand' and label = 'Thailand');
  raise notice '% | and so did the other ten',
    (select count(*) from nationalities where code in
      ('china','japan','south_korea','singapore','malaysia','hong_kong',
       'taiwan','united_states','united_kingdom','australia')) = 10;

  -- Not offered for a hand count, deliberately.
  select count(*) into v_n from nationalities
   where code in ('unknown','unrecorded') and offer_in_counts;
  raise notice '% | unknown and unrecorded are NOT offered for a count (%)', v_n = 0, v_n;

  raise notice '% | Other still is', (select offer_in_counts from nationalities where code = 'other');

  -- Alphabetical by label is what the screen shows; sort_order follows it
  -- so a client that trusts the column gets the same answer.
  select count(*) into v_n from (
    select code, label, sort_order,
           row_number() over (order by label) rn,
           row_number() over (order by sort_order) ro
      from nationalities where sort_order < 9000) t
   where rn <> ro;
  raise notice '% | sort_order agrees with alphabetical (% out of place)', v_n = 0, v_n;
end $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
--   There is no safe automatic rollback: deleting the added countries
--   would orphan any row keyed against one. Set `active = false` on the
--   unwanted ones instead, which is what `active` is for.

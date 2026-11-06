drop view if exists v_tb_union;
create view v_tb_union as
-- transactions by currency - EUR
SELECT
a.name, round(r.value,2) as EUR, 0 as GBP, 0 as HKD, 0 as JPY, 0 as MTL, 0 as NZD, 0 as SGD, 0 as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'EUR' 
-- transactions by currency GBP
union all
SELECT
a.name, 0 as EUR, round(r.value,2) as GBP, 0 as HKD, 0 as JPY, 0 as MTL, 0 as NZD, 0 as SGD, 0 as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'GBP' 
-- transactions by currency HKD
union all
SELECT
a.name, 0 as EUR, 0 as GBP, round(r.value,2) as HKD, 0 as JPY, 0 as MTL, 0 as NZD, 0 as SGD, 0 as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'HKD' 
-- transactions by currency JPY
union all
SELECT
a.name, 0 as EUR, 0 as GBP, 0 as HKD, round(r.value,2) as JPY, 0 as MTL, 0 as NZD, 0 as SGD, 0 as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'JPY' 
-- transactions by currency MTL
union all
SELECT
a.name, 0 as EUR, 0 as GBP, 0 as HKD, 0 as JPY, round(r.value,2) as MTL, 0 as NZD, 0 as SGD, 0 as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'MTL' 
-- transactions by currency NZD
union all
SELECT
a.name, 0 as EUR, 0 as GBP, 0 as HKD, 0 as JPY, 0 as MTL, round(r.value,2) as NZD, 0 as SGD, 0 as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'NZD' 
-- transactions by currency SGD
union all
SELECT
a.name, 0 as EUR, 0 as GBP, 0 as HKD, 0 as JPY, 0 as MTL, 0 as NZD, round(r.value,2) as SGD, 0 as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'SGD' 
-- transactions by currency USD
union all
SELECT
a.name, 0 as EUR, 0 as GBP, 0 as HKD, 0 as JPY, 0 as MTL, 0 as NZD, 0 as SGD, round(r.value,2) as USD, 0 as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'USD' 
-- transactions by currency UYU
union all
SELECT
a.name, 0 as EUR, 0 as GBP, 0 as HKD, 0 as JPY, 0 as MTL, 0 as NZD, 0 as SGD, 0 as USD, round(r.value,2) as UYU
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
left join t_accounts as a
on r.account = a.id
where t.commodity = 'UYU' 
;

-- group QUERY
drop view if exists v_tb_group;
create view v_tb_group as
select 
r.name, round(sum(EUR),2) as EUR, round(sum(GBP),2) as GBP, round(sum(HKD),2) as HKD, round(sum(JPY),2) as JPY, round(sum(MTL),2) as MTL, 
round(sum(NZD),2) as NZD, round(sum(SGD),2) as SGD, round(sum(USD),2) as USD, round(sum(UYU),2) as UYU 
from v_tb_union as r
group by name;

select name, EUR, GBP, HKD, JPY, MTL, NZD, SGD, USD, UYU  
from v_tb_group
union ALL
select 'total' as name, round(sum(EUR),2) as EUR, round(sum(GBP),2) as GBP, round(sum(HKD),2) as HKD, round(sum(JPY),2) as JPY, round(sum(MTL),2) as MTL, 
round(sum(NZD),2) as NZD, round(sum(SGD),2) as SGD,
 round(sum(USD),2) as USD, round(sum(UYU),2) as UYU
from v_tb_group
group by 'total'
;

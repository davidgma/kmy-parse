SELECT
t.commodity
from t_splits as r 
left join t_transactions as t
on r.transaction_id = t.id
group by 
t.commodity
#!/usr/bin/env python3
"""Generate DEMO tenant data for the card-disputes pack.

This is *tenant* data for a throwaway demo tenant — NOT pack data. Packs ship
zero data by design (no-dummy-data rule); the pack declares a binding contract
and the tenant supplies real datasets. This generator produces datasets whose
names + columns match packs/card-disputes/data/datasets.yaml exactly, so the
install binds by same-name reuse.

Everything is fictional: invented merchants, invented cardholder names, no real
BINs, no PANs, no PII. Deterministic (fixed seed) so a rehearsal and a live demo
show identical numbers.

Row mix is engineered so every rule in decisions/reg_e_triage.yaml fires, and so
the dashboards have a believable shape (a real book has mostly routine disputes
and a few emergencies).
"""
from __future__ import annotations
import csv, random
from pathlib import Path

random.seed(20260724)          # deterministic: rehearsal == live demo
OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)

# ---------------------------------------------------------------- cardholders
FIRST = ["Alina","Marcus","Priya","Devon","Rosa","Tomas","Nadia","Elliot","Cora",
         "Idris","Mei","Hakim","Sofia","Gareth","Yuki","Omar","Lena","Rafael",
         "Ines","Björn","Amara","Tobias","Fen","Kwame","Sadie","Vikram"]
LAST  = ["Vance","Okonjo","Ramachandran","Bellweather","Ferrante","Lindqvist",
         "Achebe","Moreau","Santoro","Nakamura","Delacroix","Ashworth","Petrov",
         "Osei","Calderon","Winterbourne","Haddad","Novak","Quill","Marchetti"]
SEGMENTS  = ["retail","premium","student","small_business"]
PRODUCTS  = ["classic_debit","platinum_credit","rewards_credit","business_debit"]
STATES    = ["CA","NY","TX","FL","IL","WA","MA","GA","CO","NC","OH","AZ"]
RISK      = ["low","low","low","medium","medium","high"]          # skewed low
AGE_BUCKET= ["lt_1y","1_3y","3_5y","gt_5y"]

cardholders = []
for i in range(1, 41):
    tenure = random.randint(2, 190)
    cardholders.append({
        "cardholder_id": f"CH-{1000+i}",
        "cardholder_name": f"{random.choice(FIRST)} {random.choice(LAST)}",
        "segment": random.choice(SEGMENTS),
        "card_product": random.choice(PRODUCTS),
        "home_state": random.choice(STATES),
        "tenure_months": tenure,
        "risk_tier": random.choice(RISK),
        "prior_dispute_count": random.choices([0,0,0,1,1,2,3,5],k=1)[0],
        "account_age_bucket": ("lt_1y" if tenure < 12 else "1_3y" if tenure < 36
                               else "3_5y" if tenure < 60 else "gt_5y"),
    })

# --------------------------------------------------------------- transactions
MERCHANTS = [
    ("Northwind Grocers", 5411, "US"), ("Vellum Electronics", 5732, "US"),
    ("Harbour Airlines", 4511, "US"), ("Cobblestone Coffee", 5814, "US"),
    ("Lumen Streaming", 5968, "US"), ("Ridgeline Outfitters", 5941, "US"),
    ("Marisol Resorts", 7011, "MX"), ("Copperfield Fuel", 5541, "US"),
    ("Adelaide Pharmacy", 5912, "US"), ("Pelagic Freight", 4214, "NL"),
    ("Starling Fitness", 7997, "US"), ("Orchid Home Goods", 5719, "CA"),
]
CHANNELS = ["card_present","card_not_present"]
ENTRY    = ["chip","contactless","ecommerce","recurring","magstripe"]

transactions = []
for i in range(1, 161):
    ch = random.choice(cardholders)
    m_name, mcc, country = random.choice(MERCHANTS)
    channel = random.choices(CHANNELS, weights=[45,55])[0]
    entry = ("recurring" if channel == "card_not_present" and random.random() < .28
             else "ecommerce" if channel == "card_not_present"
             else random.choice(["chip","contactless","magstripe"]))
    month = random.choice(["2026-05","2026-06","2026-07"])
    day = random.randint(1, 28)
    transactions.append({
        "txn_id": f"TX-{20000+i}",
        "cardholder_id": ch["cardholder_id"],
        "account_id": f"AC-{ch['cardholder_id'][3:]}",
        "txn_date": f"{month}-{day:02d}",
        "txn_month": month,
        "mcc": mcc,
        "merchant_name": m_name,
        "merchant_country": country,
        "channel": channel,
        "entry_mode": entry,
        "amount": round(random.uniform(8, 2400), 2),
    })

# -------------------------------------------------------------------- disputes
# Deliberate mix so every reg_e_triage rule has live matches.
#   overdue (<0)                -> rule 1  route_investigation_review CRITICAL
#   clock 0-2                   -> rule 2  route_investigation_review CRITICAL
#   reg_e + credit due + 0-3    -> rule 3  route_investigation_review CRITICAL
#   fraud_unauthorized >= $500  -> rule 4  escalate_fraud_review HIGH
#   fraud_unauthorized <= $50   -> rule 5  resolve_cardholder_favor LOW
#   cancelled_recurring         -> rule 6  file_chargeback MEDIUM
#   not_received                -> rule 7  escalate_fraud_review HIGH
#   everything else             -> default route_investigation_review MEDIUM
DTYPES = ["fraud_unauthorized","cancelled_recurring","not_received",
          "duplicate_charge","credit_not_processed","atm_shortfall",
          "quality_defective"]
REASON = {"fraud_unauthorized":"10.4","cancelled_recurring":"13.2",
          "not_received":"13.1","duplicate_charge":"12.6.1",
          "credit_not_processed":"13.6","atm_shortfall":"13.7",
          "quality_defective":"13.5"}
CLOSED_DISPOSITIONS = ["resolve_cardholder_favor","deny_no_error_found",
                       "chargeback_won","chargeback_lost","close_merchant_credited"]

def bucket(days: int) -> str:
    if days < 0:   return "overdue"
    if days <= 7:  return "0_7_days"
    if days <= 30: return "8_30_days"
    return "gt_30_days"

disputes = []
def add(n, *, dtype=None, days=None, amount=None, reg=None, pcredit=None,
        status=None, closed_disp=None):
    for _ in range(n):
        t = random.choice(transactions)
        ch = next(c for c in cardholders if c["cardholder_id"] == t["cardholder_id"])
        dt = dtype or random.choice(DTYPES)
        dd = days if days is not None else random.randint(3, 45)
        amt = amount if amount is not None else t["amount"]
        rf = reg or ("reg_e" if ch["card_product"].endswith("debit") else "reg_z")
        st = status or random.choices(["open","closed"], weights=[62,38])[0]
        disp = ""
        rec = 0.0
        if st == "closed":
            disp = closed_disp or random.choice(CLOSED_DISPOSITIONS)
            if disp in ("chargeback_won","resolve_cardholder_favor","close_merchant_credited"):
                rec = round(amt, 2)
        pc = pcredit or random.choice(["not_required","due","issued","reversed"])
        i = len(disputes) + 1
        disputes.append({
            "dispute_id": f"DP-{4000+i}",
            "cardholder_id": ch["cardholder_id"],
            "account_id": t["account_id"],
            "txn_id": t["txn_id"],
            "network": "visa" if "visa" not in ch["card_product"] else "visa",
            "card_product": ch["card_product"],
            "dispute_type": dt,
            "reason_code": REASON[dt],
            "reg_flag": rf,
            "severity": "medium",           # pre-triage posture; the TABLE decides
            "status": st,
            "disposition": disp,
            "provisional_credit": pc,
            "chargeback_filed": "yes" if disp in ("chargeback_won","chargeback_lost") else "no",
            "deadline_bucket": bucket(dd),
            "assigned_tier": random.choice(["tier1","tier2","tier3"]),
            "filed_month": t["txn_month"],
            "age_days": max(1, 60 - dd if dd < 60 else random.randint(1, 20)),
            "deadline_days_left": dd,
            "amount": round(amt, 2),
            "recovery_amount": rec,
        })

# the emergencies (small in number — that's what makes them findable)
add(6,  days=random.randint(-9, -1), status="open", pcredit="due")      # OVERDUE
add(5,  days=random.randint(0, 2),  status="open")                      # clock <=2
add(4,  dtype="fraud_unauthorized", days=2, reg="reg_e",
        pcredit="due", status="open")                                   # prov-credit at risk
# the routine book
add(14, dtype="fraud_unauthorized", amount=random.uniform(500, 3200), status="open")
add(8,  dtype="fraud_unauthorized", amount=random.uniform(9, 49), status="open")
add(12, dtype="cancelled_recurring")
add(11, dtype="not_received")
add(10, dtype="duplicate_charge")
add(9,  dtype="credit_not_processed")
add(7,  dtype="atm_shortfall")
add(9,  dtype="quality_defective")
# closed history so win-rate / recovery KPIs have something to show
add(22, status="closed")

def write(name, rows, cols):
    p = OUT / f"{name}.csv"
    with p.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"  {p.name}: {len(rows)} rows, {len(cols)} cols")

write("cd-cardholders", cardholders,
      ["cardholder_id","cardholder_name","segment","card_product","home_state",
       "tenure_months","risk_tier","prior_dispute_count","account_age_bucket"])
write("cd-transactions", transactions,
      ["txn_id","cardholder_id","account_id","txn_date","txn_month","mcc",
       "merchant_name","merchant_country","channel","entry_mode","amount"])
write("cd-disputes", disputes,
      ["dispute_id","cardholder_id","account_id","txn_id","network","card_product",
       "dispute_type","reason_code","reg_flag","severity","status","disposition",
       "provisional_credit","chargeback_filed","deadline_bucket","assigned_tier",
       "filed_month","age_days","deadline_days_left","amount","recovery_amount"])

overdue = [d for d in disputes if d["deadline_days_left"] < 0]
print(f"\n{len(disputes)} disputes | {len([d for d in disputes if d['status']=='open'])} open"
      f" | {len(overdue)} OVERDUE (rule-1 criticals)")
print(f"open dollars: ${sum(d['amount'] for d in disputes if d['status']=='open'):,.2f}")
print(f"recovered:    ${sum(d['recovery_amount'] for d in disputes):,.2f}")

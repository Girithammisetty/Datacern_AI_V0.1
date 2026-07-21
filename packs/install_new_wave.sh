#!/bin/sh
# Install the 18 new vertical packs (BRDs 34-51) into their own tenants,
# sequentially, via the proven onboard_pack_tenant.py path. Run from packs/.
# UI restart is suppressed until the LAST pack so logins land in one reload.
set -u
PY=../deploy/e2e/.venv/bin/python
LOG_DIR=.install-logs
mkdir -p "$LOG_DIR"
fail=0

install_one() {
  pack="$1"; tenant="$2"; display="$3"; short="$4"; restart="$5"
  extra="--no-restart-ui"
  [ "$restart" = "restart" ] && extra=""
  echo "==> $pack -> $tenant"
  if $PY onboard_pack_tenant.py --pack "$pack" --tenant "$tenant" \
       --display "$display" --short "$short" $extra \
       > "$LOG_DIR/$pack.log" 2>&1; then
    grep -E "installed: |FAIL|failed" "$LOG_DIR/$pack.log" | tail -3
  else
    echo "  FAIL $pack — see $LOG_DIR/$pack.log"
    tail -5 "$LOG_DIR/$pack.log"
    fail=1
  fi
}

install_one workers-comp-claims      wr-wcomp        "Datacern Workers Comp"          wcomp        no
install_one trade-compliance         wr-trade        "Datacern Trade Compliance"      trade        no
install_one trucking-claims          wr-trucking     "Datacern Trucking Claims"       trucking     no
install_one warranty-claims          wr-warranty     "Datacern Warranty Claims"       warranty     no
install_one mortgage-loss-mitigation wr-lossmit      "Datacern Loss Mitigation"       lossmit      no
install_one credit-disputes          wr-fcra         "Datacern Credit Disputes"       fcra         no
install_one background-screening     wr-screening    "Datacern Background Screening"  screening    no
install_one trust-safety-appeals     wr-appeals      "Datacern Trust & Safety"        appeals      no
install_one device-complaints        wr-mdr          "Datacern Device Vigilance"      mdr          no
install_one underwriting-intake      wr-uw           "Datacern Underwriting Intake"   uw           no
install_one chargeback-representment wr-merchant     "Datacern Merchant Disputes"     merchant     no
install_one seller-vetting           wr-marketplace  "Datacern Marketplace Integrity" marketplace  no
install_one benefits-appeals         wr-benefits     "Datacern Benefits Adjudication" benefits     no
install_one utility-inspections      wr-utility      "Datacern Utility Inspections"   utility      no
install_one construction-claims      wr-construction "Datacern Construction Claims"   construction no
install_one ap-invoice-audit         wr-apaudit      "Datacern AP Audit"              apaudit      no
install_one manufacturing-mrb        wr-mrb          "Datacern Manufacturing Quality" mrb          no
install_one tax-notices              wr-tax          "Datacern Tax Notices"           tax          restart

echo "=== batch done, fail=$fail ==="
exit $fail

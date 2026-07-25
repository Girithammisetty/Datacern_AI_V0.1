package domain

import "github.com/google/uuid"

// URN builders (MASTER-FR-013): wr:<tenant>:usage:<type>/<id>.
func BudgetURN(tenant, id uuid.UUID) string {
	return "wr:" + tenant.String() + ":usage:budget/" + id.String()
}

func AnomalyURN(tenant, id uuid.UUID) string {
	return "wr:" + tenant.String() + ":usage:anomaly/" + id.String()
}

func ReconciliationURN(id uuid.UUID) string {
	return "wr:*:usage:reconciliation/" + id.String()
}

func RateCardURN(id uuid.UUID) string {
	return "wr:*:usage:ratecard/" + id.String()
}

func AdjustmentURN(tenant, id uuid.UUID) string {
	return "wr:" + tenant.String() + ":usage:adjustment/" + id.String()
}

// ValueAssumptionsURN identifies a value_assumptions version (BRD 69 design §2.1).
func ValueAssumptionsURN(tenant, id uuid.UUID) string {
	return "wr:" + tenant.String() + ":usage:value_assumptions/" + id.String()
}

// ValueExportURN identifies a value-report export (BRD 69 design §2.8).
func ValueExportURN(tenant, id uuid.UUID) string {
	return "wr:" + tenant.String() + ":usage:value_export/" + id.String()
}

package reports

import (
	"fmt"
	"html"
	"strings"
	"time"
)

// maxRowsInEmail caps how many data rows are inlined per chart in the digest
// (an email digest, not the full dataset — matches the platform's documented
// v1 scope: a real HTML/text summary, not pixel-perfect rendering).
const maxRowsInEmail = 20

// RenderedReport is the subject/HTML/text triple ready to hand to email.Sender.
type RenderedReport struct {
	Subject string
	HTML    string
	Text    string
}

// Render builds a real digest email from a dashboard's live data (no
// lorem-ipsum, no fabricated numbers — every row here is exactly what
// chart-service returned for this send).
func Render(digest *DashboardDigest, generatedAt time.Time) RenderedReport {
	return RenderWithDecisions(digest, nil, generatedAt)
}

// RenderWithDecisions is Render plus the two sections that make this a report
// rather than a chart dump: what the period's numbers MEAN (narrative) and what
// the team actually decided in it (decisions).
//
// `decisions` is nil when case-service could not be reached. That path omits
// both sections entirely — it never renders zeroes. A digest that says "0 cases
// resolved" because an HTTP call failed is a false statement to an executive,
// and it is indistinguishable from a genuinely quiet week.
func RenderWithDecisions(digest *DashboardDigest, decisions *DecisionsDigest, generatedAt time.Time) RenderedReport {
	subject := fmt.Sprintf("Datacern report: %s (%s)", digest.DashboardName, generatedAt.Format("Jan 2, 2006"))

	var h strings.Builder
	h.WriteString(`<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:760px">`)
	fmt.Fprintf(&h, `<h1 style="font-size:20px;margin:0 0 4px">%s</h1>`, html.EscapeString(digest.DashboardName))
	fmt.Fprintf(&h, `<p style="color:#666;font-size:13px;margin:0 0 20px">Generated %s by your Datacern report subscription.</p>`,
		html.EscapeString(generatedAt.Format(time.RFC1123)))

	var t strings.Builder
	fmt.Fprintf(&t, "%s\nGenerated %s by your Datacern report subscription.\n\n", digest.DashboardName, generatedAt.Format(time.RFC1123))

	// Narrative first: a manager forwarding this reads the top three lines.
	if lines := Narrative(decisions); len(lines) > 0 {
		h.WriteString(`<div style="background:#f8fafc;border-left:3px solid #64748b;padding:12px 14px;margin:0 0 20px">`)
		for _, ln := range lines {
			fmt.Fprintf(&h, `<p style="margin:0 0 6px;font-size:14px">%s</p>`, html.EscapeString(ln))
		}
		h.WriteString(`</div>`)
		t.WriteString(NarrativeText(lines) + "\n\n")
	}

	if decisions != nil {
		h.WriteString(`<h2 style="font-size:15px;margin:0 0 8px">Decisions this period</h2>`)
		h.WriteString(`<table style="border-collapse:collapse;font-size:13px;margin-bottom:20px">`)
		t.WriteString("## Decisions this period\n")
		rows := [][2]string{
			{"Resolved", fmt.Sprint(decisions.Resolved)},
			{"Closed", fmt.Sprint(decisions.Closed)},
			{"Opened", fmt.Sprint(decisions.Opened)},
			{"Still open", fmt.Sprint(decisions.OpenTotal)},
			{"Past SLA", fmt.Sprint(decisions.SLABreached)},
		}
		// Median is appended ONLY when a sample exists — see DecisionsDigest:
		// printing "0s" for "nothing resolved" would claim instant decisions.
		if decisions.P50Seconds != nil && decisions.Sample > 0 {
			rows = append(rows, [2]string{"Median time to decision",
				fmt.Sprintf("%s (n=%d)", humanDuration(*decisions.P50Seconds), decisions.Sample)})
		}
		for _, r := range rows {
			fmt.Fprintf(&h, `<tr><td style="padding:4px 14px 4px 0;color:#666">%s</td>`+
				`<td style="padding:4px 0;font-weight:600">%s</td></tr>`,
				html.EscapeString(r[0]), html.EscapeString(r[1]))
			fmt.Fprintf(&t, "%s: %s\n", r[0], r[1])
		}
		h.WriteString(`</table>`)
		t.WriteString("\n")
	}

	if len(digest.Charts) == 0 {
		h.WriteString(`<p>This dashboard has no charts yet.</p>`)
		t.WriteString("This dashboard has no charts yet.\n")
	}

	for _, c := range digest.Charts {
		fmt.Fprintf(&h, `<h2 style="font-size:15px;margin:24px 0 8px;border-top:1px solid #eee;padding-top:16px">%s</h2>`,
			html.EscapeString(c.Name))
		fmt.Fprintf(&t, "## %s\n", c.Name)

		if c.Error != "" {
			fmt.Fprintf(&h, `<p style="color:#b91c1c;font-size:13px">Could not resolve this chart: %s</p>`, html.EscapeString(c.Error))
			fmt.Fprintf(&t, "Could not resolve this chart: %s\n\n", c.Error)
			continue
		}
		if len(c.Columns) == 0 {
			h.WriteString(`<p style="color:#666;font-size:13px">No data.</p>`)
			t.WriteString("No data.\n\n")
			continue
		}

		h.WriteString(`<table style="border-collapse:collapse;width:100%;font-size:13px">`)
		h.WriteString(`<thead><tr>`)
		for _, col := range c.Columns {
			fmt.Fprintf(&h, `<th style="text-align:left;border-bottom:2px solid #ddd;padding:6px 10px">%s</th>`, html.EscapeString(col))
		}
		h.WriteString(`</tr></thead><tbody>`)
		t.WriteString(strings.Join(c.Columns, "\t") + "\n")

		shown := c.Rows
		if len(shown) > maxRowsInEmail {
			shown = shown[:maxRowsInEmail]
		}
		for _, row := range shown {
			h.WriteString(`<tr>`)
			var cells []string
			for _, v := range row {
				s := fmt.Sprintf("%v", v)
				fmt.Fprintf(&h, `<td style="border-bottom:1px solid #eee;padding:6px 10px">%s</td>`, html.EscapeString(s))
				cells = append(cells, s)
			}
			h.WriteString(`</tr>`)
			t.WriteString(strings.Join(cells, "\t") + "\n")
		}
		h.WriteString(`</tbody></table>`)

		if c.Truncated || len(c.Rows) > maxRowsInEmail {
			fmt.Fprintf(&h, `<p style="color:#888;font-size:12px;margin-top:6px">Showing %d of %d rows. Open the dashboard in Datacern for the full result.</p>`,
				len(shown), c.RowCount)
			fmt.Fprintf(&t, "(showing %d of %d rows)\n", len(shown), c.RowCount)
		}
		t.WriteString("\n")
	}

	h.WriteString(`<p style="color:#999;font-size:11px;margin-top:28px">You are receiving this because you are subscribed to this dashboard report in Datacern. Manage your subscription from Dashboards &gt; Reports.</p>`)
	h.WriteString(`</div>`)
	t.WriteString("You are receiving this because you are subscribed to this dashboard report in Datacern.\n")

	return RenderedReport{Subject: subject, HTML: h.String(), Text: t.String()}
}

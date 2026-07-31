package reports

import (
	"fmt"
	"strings"
)

// Narrative turns the period's real aggregates into the sentences a manager
// forwards to an executive.
//
// COMPOSED, NOT GENERATED — and that is a deliberate refusal, not a shortcut.
// An LLM could phrase this more elegantly, but this text is emailed on a
// schedule, unread by its author, to someone who will act on it. A model that
// rounds 3 resolutions up to "a strong week", or invents a trend from two data
// points, produces a confident false statement with nobody in the loop to catch
// it. Every clause below is a direct restatement of a number case-service
// actually returned; there is no sentence here that can be true of one dataset
// and printed for another.
//
// If an LLM is ever added, the honest shape is to let it PHRASE these facts,
// never to let it source them.
func Narrative(d *DecisionsDigest) []string {
	if d == nil {
		return nil
	}
	period := "day"
	if d.WindowDays > 1 {
		period = fmt.Sprintf("%d days", d.WindowDays)
	}
	var out []string

	// Throughput. Opened vs resolved is the one comparison a manager acts on:
	// it says whether the queue is being kept up with, which neither number
	// says alone.
	switch {
	case d.Resolved == 0 && d.Opened == 0:
		out = append(out, fmt.Sprintf("No cases were opened or resolved in the last %s.", period))
	case d.Resolved == 0:
		out = append(out, fmt.Sprintf(
			"%d case(s) were opened in the last %s and none were resolved.", d.Opened, period))
	default:
		verdict := "keeping pace with intake"
		if d.Resolved < d.Opened {
			verdict = fmt.Sprintf("behind intake by %d", d.Opened-d.Resolved)
		} else if d.Resolved > d.Opened {
			verdict = fmt.Sprintf("ahead of intake by %d", d.Resolved-d.Opened)
		}
		out = append(out, fmt.Sprintf(
			"%d case(s) resolved and %d opened in the last %s — %s.",
			d.Resolved, d.Opened, period, verdict))
	}

	// Time to decision. Stated ONLY when there is a sample, and the sample size
	// travels with it: "median 2.1d" over three cases is not a median anyone
	// should plan against, and the reader is the only one who can judge that.
	if d.P50Seconds != nil && d.Sample > 0 {
		s := fmt.Sprintf("Median time to decision was %s", humanDuration(*d.P50Seconds))
		if d.Sample < 5 {
			s += fmt.Sprintf(" — across only %d resolved case(s), too few to read as a trend", d.Sample)
		} else {
			s += fmt.Sprintf(" across %d resolved cases", d.Sample)
		}
		out = append(out, s+".")
	}

	// Backlog + SLA. Breaches lead when present: it is the only line here that
	// is asking someone to do something.
	if d.SLABreached > 0 {
		out = append(out, fmt.Sprintf(
			"%d of the %d still-open case(s) are past their SLA date.", d.SLABreached, d.OpenTotal))
	} else if d.OpenTotal > 0 {
		out = append(out, fmt.Sprintf(
			"%d case(s) remain open, none past their SLA date.", d.OpenTotal))
	}
	return out
}

// humanDuration renders seconds the way the approver panel does, so a manager
// reading the email and the panel sees the same shape of number.
func humanDuration(seconds int64) string {
	switch {
	case seconds < 60:
		return fmt.Sprintf("%ds", seconds)
	case seconds < 3600:
		return fmt.Sprintf("%dm", seconds/60)
	case seconds < 48*3600:
		return fmt.Sprintf("%.1fh", float64(seconds)/3600)
	default:
		return fmt.Sprintf("%.1fd", float64(seconds)/86400)
	}
}

// NarrativeText joins the narrative for the plain-text part.
func NarrativeText(lines []string) string {
	return strings.Join(lines, " ")
}

//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParityNormalizeSlackLookupToken(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"@darksky":    "darksky",
		"<@U123ABC>":  "u123abc",
		"Huang 哥":     "huang哥",
		" Peng-Xiao ": "pengxiao",
	}

	for input, want := range cases {
		if got := normalizeSlackLookupToken(input); got != want {
			t.Fatalf("normalizeSlackLookupToken(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestCueboardParityBestSlackUserMatch(t *testing.T) {
	t.Parallel()

	users := []slackLookupUser{
		{
			ID:                    "U1",
			Name:                  "darksky",
			DisplayName:           "darksky",
			DisplayNameNormalized: "darksky",
			RealName:              "Dark Sky",
			RealNameNormalized:    "Dark Sky",
		},
		{
			ID:                    "U2",
			Name:                  "eyhn",
			DisplayName:           "EYHN",
			DisplayNameNormalized: "EYHN",
			RealName:              "Yi Han",
			RealNameNormalized:    "Yi Han",
		},
		{
			ID:                    "U3",
			Name:                  "huang.ge",
			DisplayName:           "Huang 哥",
			DisplayNameNormalized: "Huang 哥",
			RealName:              "Huang Ge",
			RealNameNormalized:    "Huang Ge",
		},
		{
			ID:                    "U4",
			Name:                  "haowen",
			DisplayName:           "Haowen",
			DisplayNameNormalized: "Haowen",
			RealName:              "Haowen Xu",
			RealNameNormalized:    "Haowen Xu",
		},
		{
			ID:                    "U5",
			Name:                  "haohao",
			DisplayName:           "Haohao",
			DisplayNameNormalized: "Haohao",
			RealName:              "Hao Hao",
			RealNameNormalized:    "Hao Hao",
		},
	}

	match, _, ok := bestSlackUserMatch("darksky", users)
	if !ok || match.ID != "U1" {
		t.Fatalf("darksky match = %+v, ok=%v", match, ok)
	}

	match, _, ok = bestSlackUserMatch("<@U2>", users)
	if !ok || match.ID != "U2" {
		t.Fatalf("direct ID match = %+v, ok=%v", match, ok)
	}

	match, _, ok = bestSlackUserMatch("Huang哥", users)
	if !ok || match.ID != "U3" {
		t.Fatalf("Huang哥 match = %+v, ok=%v", match, ok)
	}

	if _, _, ok := bestSlackUserMatch("hao", users); ok {
		t.Fatal("expected ambiguous partial match for hao to fail")
	}
}

package slackagent

import "testing"

func TestBuildSlackWorkspacePolicyStatus(t *testing.T) {
	t.Parallel()

	empty := buildSlackWorkspacePolicyStatus(" \n ")
	if empty.Configured || empty.Source != "unset" || empty.Version != "" || empty.Hash != "" || empty.LengthChars != 0 {
		t.Fatalf("empty status = %#v, want unconfigured unset status", empty)
	}

	first := buildSlackWorkspacePolicyStatus("Reply to product-adjacent articles.")
	second := buildSlackWorkspacePolicyStatus("Reply to product-adjacent articles.")
	changed := buildSlackWorkspacePolicyStatus("Stay silent on product-adjacent articles.")
	if !first.Configured || first.Source != slackWorkspacePolicySourceConfig {
		t.Fatalf("configured status = %#v, want config source", first)
	}
	if first.Version == "" || first.Hash == "" || first.LengthChars == 0 {
		t.Fatalf("configured status = %#v, want version/hash/length", first)
	}
	if first.Version != second.Version || first.Hash != second.Hash {
		t.Fatalf("stable hash changed: first=%#v second=%#v", first, second)
	}
	if first.Version == changed.Version || first.Hash == changed.Hash {
		t.Fatalf("changed policy kept same version/hash: first=%#v changed=%#v", first, changed)
	}
}

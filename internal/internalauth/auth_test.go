package internalauth

import "testing"

func TestIsAuthorizedAllowsLoopbackRemoteAddr(t *testing.T) {
	if !IsAuthorized("127.0.0.1:4040", "", "") {
		t.Fatal("expected loopback remote addr to bypass internal auth key")
	}
	if !IsAuthorized("[::1]:4040", "", "") {
		t.Fatal("expected IPv6 loopback remote addr to bypass internal auth key")
	}
}

func TestIsAuthorizedRequiresMatchingKeyForNonLoopback(t *testing.T) {
	if IsAuthorized("203.0.113.10:4040", "secret-key", "") {
		t.Fatal("expected missing key to fail for non-loopback remote addr")
	}
	if IsAuthorized("203.0.113.10:4040", "secret-key", "wrong-key") {
		t.Fatal("expected wrong key to fail for non-loopback remote addr")
	}
	if !IsAuthorized("203.0.113.10:4040", "secret-key", "secret-key") {
		t.Fatal("expected matching key to authorize non-loopback remote addr")
	}
}

func TestIsLoopbackRemoteAddrParsesHostPortAndBareIP(t *testing.T) {
	testCases := []struct {
		value string
		want  bool
	}{
		{value: "127.0.0.1:8080", want: true},
		{value: "[::1]:8080", want: true},
		{value: "127.0.0.1", want: true},
		{value: "::1", want: true},
		{value: "203.0.113.10:8080", want: false},
		{value: "", want: false},
	}
	for _, testCase := range testCases {
		if got := IsLoopbackRemoteAddr(testCase.value); got != testCase.want {
			t.Fatalf("IsLoopbackRemoteAddr(%q) = %v, want %v", testCase.value, got, testCase.want)
		}
	}
}

package config

import (
	"reflect"
	"strings"
)

const redactedValue = "******"

func RedactForLogging(v any) any {
	return redactValue(reflect.ValueOf(v), "", 0)
}

func redactValue(v reflect.Value, keyHint string, depth int) any {
	if depth > 8 {
		return "[TRUNCATED]"
	}
	if !v.IsValid() {
		return nil
	}

	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil
		}
		v = v.Elem()
	}

	switch v.Kind() {
	case reflect.Struct:
		t := v.Type()
		out := make(map[string]any, v.NumField())
		for i := 0; i < v.NumField(); i++ {
			field := t.Field(i)
			if field.PkgPath != "" {
				continue
			}
			name := field.Name
			if isSensitiveKey(name) {
				out[name] = redactedValue
				continue
			}
			out[name] = redactValue(v.Field(i), name, depth+1)
		}
		return out
	case reflect.Map:
		out := make(map[string]any, v.Len())
		iter := v.MapRange()
		for iter.Next() {
			key := iter.Key().String()
			if isSensitiveKey(key) || isSensitiveKey(keyHint) {
				out[key] = redactedValue
				continue
			}
			out[key] = redactValue(iter.Value(), key, depth+1)
		}
		return out
	case reflect.Slice:
		out := make([]any, 0, v.Len())
		for i := 0; i < v.Len(); i++ {
			out = append(out, redactValue(v.Index(i), keyHint, depth+1))
		}
		return out
	case reflect.String:
		if isSensitiveKey(keyHint) {
			return redactedValue
		}
		return v.String()
	default:
		if isSensitiveKey(keyHint) {
			return redactedValue
		}
		return v.Interface()
	}
}

func isSensitiveKey(value string) bool {
	key := strings.ToLower(strings.TrimSpace(value))
	if key == "" {
		return false
	}
	for _, token := range []string{"secret", "token", "key", "dsn", "password"} {
		if strings.Contains(key, token) {
			return true
		}
	}
	return false
}

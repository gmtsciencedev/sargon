package database

import (
	"testing"
	"time"
)

func TestLookupLabelColumn(t *testing.T) {
	archived := time.Now()
	fields := []FieldDef{
		{Name: "idnc", ArchivedAt: &archived},
		{Name: "dateinit"},
		{Name: "ncdescription"},
	}
	withName := append([]FieldDef{{Name: "address"}, {Name: "name"}}, fields...)

	cases := []struct {
		name    string
		fields  []FieldDef
		display string
		want    string
	}{
		{"declared active column", fields, "ncdescription", "ncdescription"},
		{"declared column archived, no name", fields, "idnc", ""},
		{"declared column unknown, no name", fields, "nope", ""},
		{"nothing declared, no name", fields, "", ""},
		{"nothing declared, name exists", withName, "", "name"},
		{"declared column archived, name exists", withName, "idnc", "name"},
	}
	for _, c := range cases {
		if got := lookupLabelColumn(c.fields, c.display); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

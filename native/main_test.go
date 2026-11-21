package main

import (
	"bytes"
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	js "github.com/MoeForge/moejs"
)

func runPackets(t *testing.T, input string, run packet) []message {
	t.Helper()
	var out bytes.Buffer
	w := wire{
		in:   json.NewDecoder(strings.NewReader(input)),
		out:  json.NewEncoder(&out),
		info: buildRuntimeInfo(),
	}
	w.out.SetEscapeHTML(false)
	pre := must(js.CompileScript("codemode-prelude.js", prelude))
	w.execute(pre, run)

	dec := json.NewDecoder(&out)
	var msgs []message
	for dec.More() {
		var msg message
		if err := dec.Decode(&msg); err != nil {
			t.Fatalf("decode output: %v", err)
		}
		msgs = append(msgs, msg)
	}
	return msgs
}

func TestNoGoComments(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob go files: %v", err)
	}
	fset := token.NewFileSet()
	for _, file := range files {
		parsed, err := parser.ParseFile(fset, file, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		for _, group := range parsed.Comments {
			for _, comment := range group.List {
				if strings.HasPrefix(comment.Text, "//go:") {
					continue
				}
				pos := fset.Position(comment.Pos())
				t.Errorf("%s:%d: comments are disallowed: %s", pos.Filename, pos.Line, comment.Text)
			}
		}
	}
}

func TestRuntimeProbe(t *testing.T) {
	msgs := runPackets(t, "", packet{
		Run:              1,
		Type:             "run",
		Code:             "return codemodeRuntime();",
		Tools:            json.RawMessage("[]"),
		Globals:          json.RawMessage("[]"),
		Store:            json.RawMessage("{}"),
		MemoryLimitBytes: 64 * 1024 * 1024,
		TimeoutMs:        5000,
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d: %v", len(msgs), msgs)
	}
	done := msgs[0]
	if done["type"] != "done" || done["ok"] != true {
		t.Fatalf("expected ok done, got %v", done)
	}
	raw, ok := done["value"].(string)
	if !ok {
		t.Fatalf("expected string value, got %T", done["value"])
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		t.Fatalf("unmarshal probe: %v", err)
	}
	if probe["engine"] != "moejs" {
		t.Fatalf("expected engine moejs, got %v", probe["engine"])
	}
	if probe["module"] != "github.com/MoeForge/moejs" {
		t.Fatalf("expected module github.com/MoeForge/moejs, got %v", probe["module"])
	}
	if int(probe["pid"].(float64)) != os.Getpid() {
		t.Fatalf("expected pid %d, got %v", os.Getpid(), probe["pid"])
	}
}

func TestToolCallAndStore(t *testing.T) {
	reply := `{"run":1,"type":"result","id":1,"ok":true,"payload":"\"hello\""}` + "\n"
	msgs := runPackets(t, reply, packet{
		Run:              1,
		Type:             "run",
		Code:             `const v = await tools.read({ path: "a" }); store("seen", v); return load("seen");`,
		Tools:            json.RawMessage(`[{"name":"read","jsName":"read","description":"read"}]`),
		Globals:          json.RawMessage("[]"),
		Store:            json.RawMessage("{}"),
		MemoryLimitBytes: 64 * 1024 * 1024,
		TimeoutMs:        5000,
	})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d: %v", len(msgs), msgs)
	}
	if msgs[0]["type"] != "call" || msgs[0]["name"] != "read" {
		t.Fatalf("expected read call, got %v", msgs[0])
	}
	done := msgs[1]
	if done["type"] != "done" || done["ok"] != true {
		t.Fatalf("expected ok done, got %v", done)
	}
	if done["value"] != `"hello"` {
		t.Fatalf("expected value \"hello\", got %v", done["value"])
	}
	if done["writes"] != `[["seen","\"hello\""]]` {
		t.Fatalf("unexpected store writes: %v", done["writes"])
	}
}

func TestErrorStackExcludesPrelude(t *testing.T) {
	msgs := runPackets(t, "", packet{
		Run:              1,
		Type:             "run",
		Code:             `throw new Error("boom");`,
		Tools:            json.RawMessage("[]"),
		Globals:          json.RawMessage("[]"),
		Store:            json.RawMessage("{}"),
		MemoryLimitBytes: 64 * 1024 * 1024,
		TimeoutMs:        5000,
	})
	if len(msgs) != 1 || msgs[0]["type"] != "done" || msgs[0]["ok"] != false {
		t.Fatalf("expected failed done, got %v", msgs)
	}
	errJSON, ok := msgs[0]["error"].(string)
	if !ok {
		t.Fatalf("expected error JSON string, got %T", msgs[0]["error"])
	}
	if strings.Contains(errJSON, "codemode-prelude.js") {
		t.Fatalf("error stack leaked prelude frame: %s", errJSON)
	}
}

func TestStalledScript(t *testing.T) {
	msgs := runPackets(t, "", packet{
		Run:              1,
		Type:             "run",
		Code:             `await new Promise(() => {});`,
		Tools:            json.RawMessage("[]"),
		Globals:          json.RawMessage("[]"),
		Store:            json.RawMessage("{}"),
		MemoryLimitBytes: 64 * 1024 * 1024,
		TimeoutMs:        5000,
	})
	if len(msgs) != 1 || msgs[0]["type"] != "done" || msgs[0]["ok"] != false {
		t.Fatalf("expected stalled error, got %v", msgs)
	}
	if !strings.Contains(msgs[0]["error"].(string), "never settle") {
		t.Fatalf("expected stalled message, got %v", msgs[0]["error"])
	}
}

func TestSequentialReuse(t *testing.T) {
	var out bytes.Buffer
	w := wire{
		in:   json.NewDecoder(strings.NewReader("")),
		out:  json.NewEncoder(&out),
		info: buildRuntimeInfo(),
	}
	w.out.SetEscapeHTML(false)
	pre := must(js.CompileScript("codemode-prelude.js", prelude))

	w.execute(pre, packet{
		Run:              1,
		Type:             "run",
		Code:             `globalThis.leaked = 1; return 1;`,
		Tools:            json.RawMessage("[]"),
		Globals:          json.RawMessage("[]"),
		Store:            json.RawMessage("{}"),
		MemoryLimitBytes: 64 * 1024 * 1024,
		TimeoutMs:        5000,
	})
	w.execute(pre, packet{
		Run:              2,
		Type:             "run",
		Code:             `return typeof globalThis.leaked;`,
		Tools:            json.RawMessage("[]"),
		Globals:          json.RawMessage("[]"),
		Store:            json.RawMessage("{}"),
		MemoryLimitBytes: 64 * 1024 * 1024,
		TimeoutMs:        5000,
	})

	dec := json.NewDecoder(&out)
	var first, second message
	if err := dec.Decode(&first); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if err := dec.Decode(&second); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	if int(first["run"].(float64)) != 1 || first["value"] != "1" {
		t.Fatalf("unexpected first run: %v", first)
	}
	if int(second["run"].(float64)) != 2 || second["value"] != `"undefined"` {
		t.Fatalf("unexpected second run: %v", second)
	}
}

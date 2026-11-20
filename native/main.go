// moejs-helper reads one Pi script at a time over a private stdio pipe.
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"reflect"
	"runtime/debug"
	"strconv"
	"time"

	js "github.com/MoeForge/moejs"
)

//go:embed prelude.js
var prelude string

type packet struct {
	Run                   int    `json:"run"`
	Type                  string `json:"type"`
	Code                  string `json:"code"`
	Tools, Globals, Store json.RawMessage
	MemoryLimitBytes      int64
	TimeoutMs             int64
	ID                    int64
	OK                    bool
	Payload               *string
}
type message = map[string]any

type wire struct {
	in  *json.Decoder
	out *json.Encoder
}

func (w wire) send(run int, msg message) {
	msg["run"] = run
	if err := w.out.Encode(msg); err != nil {
		panic(err)
	}
}

// Collapse Go API errors at the per-script boundary, never continue using a failed realm.
func check[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
func (w wire) execute(pre *js.Script, p packet) {
	defer func() {
		if e := recover(); e != nil {
			w.send(p.Run, message{"type": "crash", "message": fmt.Sprint(e)})
		}
	}()
	// Normally Node enforces the deadline and kills us. Also exit if it dies mid-script.
	watchdog := time.AfterFunc(time.Duration(p.TimeoutMs)*time.Millisecond+5*time.Second, func() { os.Exit(124) })
	defer watchdog.Stop()
	rt := js.NewRuntime(js.Options{MutableIntrinsics: true, MemoryLimit: p.MemoryLimitBytes})
	// Install before the Pi prelude locks the globals. This call stays in the helper.
	if err := rt.SetGlobal("codemodeRuntime", js.NativeFunc(func(_ *js.Realm, _ js.Value, _ []js.Value) (js.Value, error) {
		pkg := reflect.TypeOf(rt).Elem().PkgPath()
		info := message{"engine": path.Base(pkg), "module": pkg, "version": nil, "pid": os.Getpid()}
		if build, ok := debug.ReadBuildInfo(); ok {
			for _, dep := range build.Deps {
				if dep.Path != pkg {
					continue
				}
				if dep.Replace != nil {
					dep = dep.Replace
				}
				if dep.Version != "" {
					info["version"] = dep.Version
				}
				break
			}
		}
		return rt.FromGo(info)
	})); err != nil {
		panic(err)
	}
	u := js.Undefined()
	var terminal message
	bridge := check(rt.FromGo(js.NativeFunc(func(r *js.Realm, _ js.Value, args []js.Value) (js.Value, error) {
		if terminal != nil {
			return u, nil
		}
		v := func(i int) js.Value { return js.Arg(args, i) }
		s := func(i int) string { return check(r.ToString(v(i))).GoString() }
		switch kind := s(0); kind {
		case "call", "global":
			target := "tool"
			if kind == "global" {
				target = "global"
			}
			m := message{"type": "call", "target": target, "name": s(2), "id": check(strconv.Atoi(s(1)))}
			if !v(3).IsUndefined() {
				m["args"] = s(3)
			}
			w.send(p.Run, m)
		case "output":
			item := message{"type": "text", "text": s(2)}
			switch s(1) {
			case "console":
				item["console"] = true
			case "image":
				item = message{"type": "image", "data": s(2), "mimeType": s(3)}
			}
			w.send(p.Run, message{"type": "output", "item": item})
		case "done":
			ok := s(1) == "true"
			terminal = message{"type": "done", "ok": ok}
			if ok {
				terminal["writes"] = s(3)
				if !v(2).IsUndefined() {
					terminal["value"] = s(2)
				}
			} else {
				terminal["error"] = s(2)
			}
		default:
			return u, fmt.Errorf("unknown prelude event %q", kind)
		}
		return u, nil
	})))
	init := check(rt.RunScript(pre))
	api := check(rt.CallFunction(init, u, bridge, js.String(string(p.Tools)), js.String(string(p.Globals)), js.String(string(p.Store))))
	entry := check(rt.Get(api, "run"))
	settle := check(rt.Get(api, "settle"))
	stalled := check(rt.Get(api, "stalled"))
	fn := check(rt.RunScript(check(js.CompileScript("moe-codemode.js", "(async (tools, console) => {"+p.Code+"\n})"))))
	check(rt.CallFunction(entry, api, fn))
	for terminal == nil {
		check(rt.CallFunction(stalled, api))
		if terminal != nil {
			break
		}
		var reply packet
		if err := w.in.Decode(&reply); err != nil {
			os.Exit(0)
		}
		if reply.Run != p.Run {
			continue
		}
		if reply.Type != "result" {
			panic("expected a tool result")
		}
		value := u
		if reply.Payload != nil {
			value = js.String(*reply.Payload)
		}
		check(rt.CallFunction(settle, api, js.Int(reply.ID), js.Bool(reply.OK), value))
	}
	// Emit done only after the VM has returned; the host may now reuse the pipe.
	w.send(p.Run, terminal)
}
func main() {
	w := wire{json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)}
	w.out.SetEscapeHTML(false)
	pre := check(js.CompileScript("pi-prelude.js", prelude))
	for {
		var p packet
		err := w.in.Decode(&p)
		if err == io.EOF {
			return
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		switch p.Type {
		case "run":
			w.execute(pre, p)
		case "result": // late result for a completed run
		default:
			fmt.Fprintln(os.Stderr, "invalid protocol message")
			os.Exit(1)
		}
	}
}

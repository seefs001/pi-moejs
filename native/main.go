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

const hostGracePeriod = 5 * time.Second

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
	in   *json.Decoder
	out  *json.Encoder
	info message
}

func (w wire) send(run int, msg message) {
	msg["run"] = run
	if err := w.out.Encode(msg); err != nil {
		panic(err)
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func mustOK(err error) {
	if err != nil {
		panic(err)
	}
}

func buildRuntimeInfo() message {
	pkg := reflect.TypeOf((*js.Runtime)(nil)).Elem().PkgPath()
	info := message{
		"engine":  path.Base(pkg),
		"module":  pkg,
		"version": nil,
		"pid":     os.Getpid(),
	}
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
	return info
}

func newRuntime(memoryLimitBytes int64, info message) *js.Runtime {
	rt := js.NewRuntime(js.Options{MutableIntrinsics: true, MemoryLimit: memoryLimitBytes})
	mustOK(rt.SetGlobal("codemodeRuntime", js.NativeFunc(func(_ *js.Realm, _ js.Value, _ []js.Value) (js.Value, error) {
		return rt.FromGo(info)
	})))
	return rt
}

func (w wire) execute(pre *js.Script, p packet) {
	defer func() {
		if e := recover(); e != nil {
			w.send(p.Run, message{"type": "crash", "message": fmt.Sprint(e)})
		}
	}()
	deadline := time.Duration(p.TimeoutMs)*time.Millisecond + hostGracePeriod
	watchdog := time.AfterFunc(deadline, func() { os.Exit(124) })
	defer watchdog.Stop()

	rt := newRuntime(p.MemoryLimitBytes, w.info)
	u := js.Undefined()
	var terminal message
	bridge := must(rt.FromGo(js.NativeFunc(func(r *js.Realm, _ js.Value, args []js.Value) (js.Value, error) {
		if terminal != nil {
			return u, nil
		}
		v := func(i int) js.Value { return js.Arg(args, i) }
		s := func(i int) string { return must(r.ToString(v(i))).GoString() }
		switch kind := s(0); kind {
		case "call", "global":
			target := "tool"
			if kind == "global" {
				target = "global"
			}
			m := message{"type": "call", "target": target, "name": s(2), "id": must(strconv.Atoi(s(1)))}
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

	init := must(rt.RunScript(pre))
	api := must(rt.CallFunction(init, u, bridge, js.String(string(p.Tools)), js.String(string(p.Globals)), js.String(string(p.Store))))
	entry := must(rt.Get(api, "run"))
	settle := must(rt.Get(api, "settle"))
	stalled := must(rt.Get(api, "stalled"))
	fn := must(rt.RunScript(must(js.CompileScript("codemode.js", "(async (tools, console) => {"+p.Code+"\n})"))))
	must(rt.CallFunction(entry, api, fn))

	for terminal == nil {
		must(rt.CallFunction(stalled, api))
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
		must(rt.CallFunction(settle, api, js.Int(reply.ID), js.Bool(reply.OK), value))
	}
	w.send(p.Run, terminal)
}

func main() {
	w := wire{
		in:   json.NewDecoder(os.Stdin),
		out:  json.NewEncoder(os.Stdout),
		info: buildRuntimeInfo(),
	}
	w.out.SetEscapeHTML(false)
	pre := must(js.CompileScript("codemode-prelude.js", prelude))
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
		case "result":
			continue
		default:
			fmt.Fprintln(os.Stderr, "invalid protocol message")
			os.Exit(1)
		}
	}
}

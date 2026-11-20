// Sends a message to an agent in the same space: a window
// (`mod.open:send-to-agent`, e.g. from a key; props { overlay }) with, from
// the focused pane, a multi-line message, the agents in the space (not the
// source pane's own) to pick one, the one this pane last sent to picked
// first, and Send (or Cmd+Enter). While it's open the source pane is zoomed,
// so there's no mistaking which pane it sends from.
//
// The message starts as the source program's default from config.json
// (default-messages, keyed by the program table's key, e.g. "hunk"), with
// {repo} (the git root of the pane's folder) and {cwd} (the pane's folder)
// filled in.
//
// The check mark is Lucide's (ISC).

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, Checkbox } from "gpui-base";
import { agents, spaces, panes, focused, props, theme, exec, hc, notify, closeOverlay, shared, setShared, readTextFile, appHome, home, run } from "herdr";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const MOD = "send-to-agent";
const TEXT_ROWS = 5;

// shared(WINDOW) = { overlay, zoomed }: the open window, so a new one replaces
// it, and the source pane it zoomed (to show which pane it sends from), to
// unzoom when it closes.
const WINDOW = `${MOD}.window`;

// shared(LAST) = { source terminal: the agent it last sent to }, picked first
// the next time that pane opens the window; null when it sent with "Remember
// agent" off, which then starts off for that pane.
const LAST = `${MOD}.last`;

// config.json: { "default-messages": { program key: default message } }.
// Without one, config.example.json (the shipped example) is used.
async function loadConfig() {
  const read = (name) => readTextFile(`${appHome()}/mods/${MOD}/${name}`).catch(() => null);
  let name = "config.json";
  let text = await read(name);
  if (text == null) text = await read((name = "config.example.json"));
  try { return JSON.parse(text ?? "{}"); }
  catch {
    notify({ title: "Send to agent", body: `${name} isn't valid JSON`, level: "warning" });
    return {};
  }
}

// The source program's default message, placeholders filled in, or "".
async function defaultMessage(pane, machine) {
  const key = pane?.program?.key;
  if (!key) return "";
  const template = (await loadConfig())["default-messages"]?.[key];
  if (typeof template !== "string") return "";
  const cwd = pane.cwd ?? "";
  let repo = cwd;
  if (template.includes("{repo}") && cwd) {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: machine }).catch(() => null);
    if (r?.code === 0) repo = r.stdout.trim();
  }
  return template.replaceAll("{repo}", repo).replaceAll("{cwd}", cwd);
}

export default class SendToAgent extends View {
  init(p, cx) {
    this.overlay = (p ?? props() ?? {}).overlay;
    this.source = panes().find((q) => q.pane === focused()?.pane) ?? null;
    this.space = spaces().find((s) => s.tabs.some((t) => t.id === this.source?.tab)) ?? null;
    // A window doesn't close by itself when the shown tab changes: render closes it.
    this.shownTab = focused()?.tab ?? null;
    // One at a time: a window stays until closed.
    const state = shared(WINDOW);
    const open = state?.overlay;
    // A window it replaces may have zoomed the source already.
    let zoomed = open ? state.zoomed ?? null : null;
    if (!zoomed && this.source && !this.source.zoomed && this.source.movable) {
      run("pane.zoom", { pane: this.source.pane });
      zoomed = this.source.pane;
    }
    setShared(WINDOW, { overlay: this.overlay, zoomed });
    if (open && open !== this.overlay) closeOverlay(open);

    this.text = TextareaState.new({ placeholder: "Message", rows: TEXT_ROWS });
    this.text.on("change", (_e, cx) => cx.notify());
    // The textarea submits on Enter too: only Cmd+Enter (secondary) sends.
    this.text.on("submit", (e, cx) => { if (e?.secondary) this.send(cx); });
    this.text.focus();
    const last = shared(LAST)?.[this.source?.terminal];
    this.selected = last ?? null;
    // Remembering is on unless this pane last sent with it off (remembered as null).
    this.remember = last !== null;
    cx.spawn(async (cx) => {
      const message = await defaultMessage(this.source, this.space?.machine ?? null);
      // Don't overwrite what the person already started typing.
      if (message && !this.text.value()) { this.text.set_value(message); cx.notify(); }
    });
  }

  // What the tab bar shows for an agent: a named tab's name, else the terminal's title.
  label(a) {
    const named = spaces().find((s) => s.id === a.space)?.tabs.find((t) => t.id === a.tab)?.named;
    return (named && a.tab_name) || a.title || a.tab_name || a.address;
  }

  // Which pane this sends from, the way its header names it: its program's
  // icon, its name and its folder.
  from(t) {
    const p = panes().find((q) => q.pane === this.source?.pane) ?? this.source;
    const name = ((p?.program?.agent || p?.program?.shell) && p.program.name) || p?.title || p?.program?.name || "shell";
    const pic = icon(p?.program, 14, t.dim);
    const h = home();
    const cwd = p?.cwd ?? "";
    const where = cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
    return h_flex().h(22).mb(8).flex_none().px(2).gap(8).items_center()
      .child(div().flex_none().text_size(11).text_color(t.dim).child("From"))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(200).font_medium().text_color(t.foreground).child(p ? name : "No pane"))
      .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child(where))
      // Zoomed for this window: said, since the other panes are hidden meanwhile.
      .when(Boolean(p?.zoomed && shared(WINDOW)?.zoomed === p.pane), (el) => el.child(
        div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.accent + "26")
          .text_size(10.5).font_medium().text_color(t.accent).child("Zoomed"),
      ));
  }

  // Agents in the source pane's space, except the source pane's own.
  targets() {
    return agents().filter((a) => a.space === this.space?.id && a.address !== this.source?.terminal);
  }

  // The picked agent (or the last one sent to), else the first one.
  target(list) {
    return list.find((a) => a.address === this.selected) ?? list[0] ?? null;
  }

  send(cx) {
    const agent = this.target(this.targets());
    const text = this.text.value().trim();
    if (!agent || !text || this.sent) return;
    this.sent = true;
    const source = this.source?.terminal;
    if (source) {
      // Only panes still open keep their entry.
      const open = new Set(panes().map((q) => q.terminal).filter(Boolean));
      const last = Object.fromEntries(Object.entries(shared(LAST) ?? {}).filter(([k]) => open.has(k)));
      setShared(LAST, { ...last, [source]: this.remember ? agent.address : null });
    }
    closeOverlay(this.overlay);
    cx.spawn(async () => {
      const r = await hc(["send", agent.address, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) notify({ title: "Send to agent", body: `Sent to ${this.label(agent)}`, level: "success", timeout: 3000 });
      else notify({ title: "Send to agent", body: r.stderr?.trim() || "Couldn't send", level: "error" });
    });
  }

  // The window went (sent, Esc, tab switch).
  close() {
    const state = shared(WINDOW);
    if (state?.overlay !== this.overlay) return;
    // Unzoom only the pane it zoomed, if nothing unzoomed it meanwhile.
    if (state.zoomed && panes().find((q) => q.pane === state.zoomed)?.zoomed) run("pane.zoom", { pane: state.zoomed });
    setShared(WINDOW, { overlay: null, zoomed: null });
  }

  render() {
    if (!this.closing && (focused()?.tab ?? null) !== this.shownTab) {
      this.closing = true;
      closeOverlay(this.overlay);
    }
    const t = theme();
    const list = this.targets();
    const picked = this.target(list);
    const ready = Boolean(picked && this.text.value().trim());
    // A window sizes to its content: give it a definite height, or the list lays out at zero.
    const rows = Math.min(6, Math.max(1, list.length));
    const textHeight = TEXT_ROWS * 19 + 18;
    return v_flex()
      .id("send-to-agent")
      .w_full()
      .h(10 + 30 + textHeight + 8 + 22 + rows * 33 + 8 + 30 + 10)
      .bg(t.popover)
      .p(10)
      .gap(0)
      .text_size(12.5)
      // A window (mod.json): Esc reaches the mod, not the app, and a press it
      // doesn't stop would drag it.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter") this.send(cx);
        else if (e.keystroke === "escape") closeOverlay(this.overlay);
      })
      .child(this.from(t))
      .child(div().h(textHeight).flex_none().child(Textarea.new(this.text)))
      .child(div().mt(8).h(22).flex_none().px(2).text_size(11).text_color(t.dim).child("To"))
      .child(
        v_flex().id("send-to-agent-list").h(rows * 33).flex_none().gap(2).overflow_y_scrollbar()
          .when(list.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.muted).child("No other agents in this space")))
          .children(
            list.map((a) => {
              const on = a.address === picked?.address;
              const pic = icon(a.program, 14, t.foreground);
              return h_flex()
                .id(`send-${a.address}`)
                .h(31)
                .px(9)
                .gap(9)
                .flex_none()
                .items_center()
                .rounded(7)
                .text_color(t.foreground)
                .when(on, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => { this.selected = a.address; cx.notify(); })
                .when(Boolean(pic), (el) => el.child(pic))
                .child(div().flex_1().truncate().child(this.label(a)))
                .child(div().flex_none().text_size(11).text_color(t[a.status] ?? t.dim).child(a.status));
            }),
          ),
      )
      .child(
        h_flex().mt(8).h(30).flex_none().items_center().gap(8)
          .child(
            Checkbox.new("send-to-agent-remember")
              .checked(this.remember)
              .on_change((checked, cx) => { this.remember = checked; cx.notify(); })
              .flex()
              .items_center()
              .gap(6)
              .cursor_pointer()
              .text_size(11.5)
              .text_color(t.foreground)
              .child(
                div().size(14).flex_none().flex().items_center().justify_center().rounded(3).border(1)
                  .when(this.remember, (el) => el.bg(t.accent).border_color(t.accent).text_color(t.solid_foreground)
                    .child(svg("mods/send-to-agent/check.svg").size(10)))
                  .when(!this.remember, (el) => el.border_color(t.dim)),
              )
              .child("Remember agent"),
          )
          .child(div().flex_1().text_size(11).text_color(t.dim).text_right().child("⌘Enter to send"))
          .child(
            div()
              .id("send-to-agent-send")
              .px(14)
              .h(28)
              .flex()
              .items_center()
              .rounded(6)
              .font_medium()
              .when(ready, (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover((s) => s.opacity(0.9)))
              .when(!ready, (el) => el.bg(t.raised).text_color(t.dim))
              .on_click((_e, cx) => this.send(cx))
              .child("Send"),
          ),
      );
  }
}

# Figures

Generated, not drawn — and **not** by this repo. The renderers live in the
sibling Python package, which owns the frame pipeline (Pillow + ffmpeg):

    ../../percepteye-agent-flywheel/docs/assets/render.sh node      # these two
    ../../percepteye-agent-flywheel/docs/assets/render.sh spinner   # the title mark

`render.sh node` writes `flywheel-{overview,loop}-node.*` over there; they are
copied here under their plain names because this repo carries only one flavour.

**Why a flavour exists at all.** The two diagrams show what a customer would
actually type, and that differs per package. The first cut of this README
shipped the PYTHON frames — `pip install percepteye-agent-flywheel`,
`import percepteye_agent_flywheel as fw`, `fw.serve(...)`, and a
`LangChain · ADK · a CLI` chip — to people installing a harness plugin. A
figure that advertises the wrong SDK is worse than no figure.

The production beat says `PERCEPTEYE_AGENT_MODE=production` here rather than
the Python `fw.apply_current_policy(...)`, because `policyCurrent()` on this
package's transport **has no caller**: the plugin does not fetch a trained
policy, so drawing that call would invent a capability.

`flywheel-loop` is drawn on a WHITE ground (`THEME=light`, the default in
`render_flywheel_loop.py`). The dark original looked handsome in isolation and
was hard to read inline in a README — pale text on near-black, at whatever size
the page gives it, beside white page chrome. Every accent is darkened rather
than inverted, because a colour tuned to glow on #0d1117 washes out on white.

Regenerate after touching either renderer. These are documentation only —
`files` in package.json is a whitelist and excludes `docs/`, so none of this
reaches the npm tarball.

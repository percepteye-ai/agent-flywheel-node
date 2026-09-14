# Figures

Generated, not drawn — and **not** by this repo. The renderers live in the
sibling Python package, which owns the frame pipeline (Pillow + ffmpeg):

    ../../agent-flywheel/docs/assets/render.sh node      # these two
    ../../agent-flywheel/docs/assets/render.sh spinner   # the title mark

`render.sh node` writes `flywheel-{overview,loop}-node.*` over there; they are
copied here under their plain names because this repo carries only one flavour.

**Why a flavour exists at all.** The two diagrams show what a customer would
actually type, and that differs per package. The first cut of this README
shipped the PYTHON frames — `pip install agent-flywheel`,
`import agent_flywheel as fw`, `fw.serve(...)`, and a
`LangChain · ADK · a CLI` chip — to people installing a harness plugin. A
figure that advertises the wrong SDK is worse than no figure.

The production beat says `PERCEPTEYE_AGENT_MODE=production` here rather than
the Python `fw.apply_current_policy(...)`, and the closing caption says the
plugin applies both halves itself. Both are true of this lane and false of the
Python one, which is why the figures are flavoured at all: the Python SDK hands
the policy back for your code to apply and deliberately does not apply the
prompt, while this plugin applies the approved prompt through
`before_prompt_build` and the approved model through `before_model_resolve`
plus the `normalizeTransport` of a provider it registers.

So in the overview, BOTH the system-prompt row and the model row flip here,
and only the model row flips in the Python figure. That difference is a claim
about the packages, not styling — `_ROWS` in `render_overview.py` is the table
that makes it, and it is the reason a figure copied between the two repos is
wrong even when it looks right.

Regenerate after touching either renderer — and note what that sentence is:
a request, not a mechanism. Nothing in either repo compares these four files
with the ones `render.sh node` produces, so a `_ROWS` edit that is rendered but
not copied leaves this README advertising the wrong set of applied halves with
nothing anywhere going red. Treat a renderer change as a two-repo change.

These are documentation only, and that part IS mechanised: `files` in
package.json is an allowlist that excludes `docs/`, and
`test/oss-boundary.test.js` asserts it against what `npm pack` actually
produces rather than against the manifest, so no image extension and nothing
under `docs/` can reach a customer's disk.

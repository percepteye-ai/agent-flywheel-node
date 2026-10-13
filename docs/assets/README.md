# Figures

Generated, not drawn, and **not** by this repo. The renderers live in the
sibling Python package, which owns the frame pipeline (Pillow + ffmpeg):

    ../../agent-flywheel/docs/assets/render.sh            # every figure
    ../../agent-flywheel/docs/assets/render.sh overview   # or one of them

**Both READMEs show the same figures.** They draw the improvement loop:
conversations recorded where the agent runs (our SDK, the OpenTelemetry
traces it already exports, or an observability provider), sent once the
customer allows it, a new version learned from them and tested against the
agent's current best on conversations it never saw, the winner approved in
Decisions, and the round repeated. That loop is the same for this plugin and
for the Python SDK, so there is one set of files and both repos carry it under
the same names. They used to come in a Python and a Node flavour, each naming
what its own customer would type; nothing in the loop depends on that any
more.

After a render, copy `flywheel-{overview,loop}.{gif,png}` and
`flywheel-spinner.gif` here. The Python repo's
`tests/test_node_figures_match.py` compares these files with what its renderer
produced, byte for byte, and checks that both READMEs show the same figures.

These are documentation only, and that part is mechanised too: `files` in
package.json is an allowlist that excludes `docs/`, and
`test/oss-boundary.test.js` asserts it against what `npm pack` actually
produces rather than against the manifest, so no image extension and nothing
under `docs/` can reach a customer's disk.

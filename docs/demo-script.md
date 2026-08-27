# Terminal recording script

This is a short, reproducible scenario for a terminal recording. Use a throwaway
repository and the locally packed AgentGate tarball; do not use a real token.

Before recording, initialize the throwaway repository, install the packed
tarball as a development dependency, add `node_modules/` to `.gitignore`, and
commit the package files together with a baseline source file. This ensures the
offline command resolves the local binary and the recording starts from a clean
working tree.

1. Show a clean `git status` and run `npm exec --offline -- agentgate check` to
   get “No findings.”
2. Add the synthetic line below to a source file:

   ```js
   const token = "ghp_A7cK9mQ2vX5zB8nD4fH6jL0pR3sT1uW";
   ```

3. Run `npm exec --offline -- agentgate check` again. Point out the
   `secret-added` finding, its file and line, masked evidence, recommendation,
   and exit code 1.
4. Run `npm exec --offline -- agentgate check --format sarif > agentgate.sarif`
   and show that the file is valid JSON and contains `[REDACTED]`, not the
   synthetic token.

The scenario demonstrates observable behavior only; it does not claim that
heuristic scanning replaces a dedicated secret scanner or human review.

# Diagrams

C4 model views of calendar-flex, written in PlantUML with the C4-PlantUML library bundled in PlantUML's standard library (`!include <C4/...>`), so no network access is needed to render them. `docs/01-architecture.md` § C4 diagrams describes each view.

Render all of them to SVG:

```sh
plantuml -tsvg docs/diagrams/*.puml
```

Or with the jar: `java -jar plantuml.jar -tsvg docs/diagrams/*.puml`. Graphviz (`dot`) is needed for layout. The IntelliJ PlantUML Integration plugin and the VS Code PlantUML extension also preview them.

Conventions:
- A dashed border means the element arrives after M1, with its phase in the name (`docs/04-implementation-phases.md`).
- Green means the element holds plaintext of Private events. The server side never does.
- Update the diagrams in the same PR as any change that adds, removes or moves a container (agent working agreement, `docs/06`).

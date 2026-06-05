# @aso/workflow-contracts

Shared workflow and artifact contracts for typed task composition in ASO.

This package defines:
- slot-composer request envelopes
- canonical `WorkflowSpec` / `WorkflowStep` types
- compiled workflow action nodes
- durable `ArtifactSpec` types
- shared preset/catalog constants consumed by runtime and training

The exported `WORKFLOW_CATALOG` object is the stable cross-client catalog surface.
Typed compose requests should use only exported preset IDs; the shared schema now
rejects unknown preset IDs, duplicate step IDs, invalid dependencies, and cycles
before runtime compilation begins.

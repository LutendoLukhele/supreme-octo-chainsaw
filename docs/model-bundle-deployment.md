# Model bundle deployment

ASO keeps trained ONNX models outside the backend image. The app image stays small and stable; the model bundle can be swapped independently.

## Build the runtime bundle

After downloading Kaggle artifacts into `.data/models/models`, package the runtime-only payload:

```bash
npm run package:model-bundle -- --version 2026-05-19-kaggle-r1
```

This creates:

```text
.data/model-bundles/2026-05-19-kaggle-r1/
  manifest.json
  models/
    intent_classifier/
    ner_extractor/
.data/model-bundles/aso-model-runtime-bundle-2026-05-19-kaggle-r1.tar.gz
.data/model-bundles/current -> 2026-05-19-kaggle-r1
```

The bundle intentionally excludes checkpoints, eval outputs, and the unreferenced `intent_classifier/model.onnx.data` sidecar from the Kaggle export. The launch runtime payload is roughly 511 MB rather than the original multi-GB training archive.

## Deploy it

1. Upload `aso-model-runtime-bundle-<version>.tar.gz` as the model release artifact.
2. Extract it on the host or attach it as a read-only volume.
3. Point the backend at the extracted `models` directory:

```bash
ASO_MODEL_BUNDLE_PATH=/srv/aso-model-bundles/2026-05-19-kaggle-r1/models
```

`docker-compose.yml` mounts `${ASO_MODEL_BUNDLE_PATH}` at `/app/models:ro`, and the backend expects:

```bash
ML_INTENT_MODEL_DIR=/app/models/intent_classifier
ML_NER_MODEL_DIR=/app/models/ner_extractor
```

If `ASO_MODEL_BUNDLE_PATH` is omitted locally, Compose uses `.data/model-bundles/current/models`.

## Validate before rollout

Use the production-style Linux image and the extracted bundle:

```bash
docker run --rm \
  -e ML_INTENT_MODEL_DIR=/app/models/intent_classifier \
  -e ML_NER_MODEL_DIR=/app/models/ner_extractor \
  -v /absolute/path/to/bundle/models:/app/models:ro \
  aso-backend-onnx-validate \
  node dist/scripts/validate-onnx-runtime.js
```

The smoke test must load both ONNX models and convert the canonical product workflows into `WorkflowSpec` objects before rollout.

import {
  OUTPUT_PRESETS,
  WHEN_PRESETS,
  WHAT_PRESETS,
  OutputPresetDefinition,
  WhenPresetDefinition,
  WhatPresetDefinition,
} from '@aso/workflow-contracts';

export class WorkflowCatalogService {
  private readonly whatById = new Map<string, WhatPresetDefinition>(
    WHAT_PRESETS.map((preset) => [preset.id, preset]),
  );
  private readonly whenById = new Map<string, WhenPresetDefinition>(
    WHEN_PRESETS.map((preset) => [preset.id, preset]),
  );
  private readonly outputById = new Map<string, OutputPresetDefinition>(
    OUTPUT_PRESETS.map((preset) => [preset.id, preset]),
  );

  getWhatPreset(id: string): WhatPresetDefinition {
    const preset = this.whatById.get(id);
    if (!preset) throw new Error(`Unknown whatPresetId: ${id}`);
    return preset;
  }

  getWhenPreset(id: string): WhenPresetDefinition {
    const preset = this.whenById.get(id);
    if (!preset) throw new Error(`Unknown whenPresetId: ${id}`);
    return preset;
  }

  getOutputPreset(id: string): OutputPresetDefinition {
    const preset = this.outputById.get(id);
    if (!preset) throw new Error(`Unknown outputPresetId: ${id}`);
    return preset;
  }

  listWhatPresets(): readonly WhatPresetDefinition[] {
    return WHAT_PRESETS;
  }

  listWhenPresets(): readonly WhenPresetDefinition[] {
    return WHEN_PRESETS;
  }

  listOutputPresets(): readonly OutputPresetDefinition[] {
    return OUTPUT_PRESETS;
  }

  renderStepDisplayText(whatId: string, whenId: string, outputId: string): string {
    const what = this.getWhatPreset(whatId);
    const when = this.getWhenPreset(whenId);
    const output = this.getOutputPreset(outputId);
    const scope = when.displayPhrase ? ` ${when.displayPhrase}` : '';
    return `Find ${what.displayNoun}${scope} and ${output.displayPhrase}`;
  }
}

export const workflowCatalogService = new WorkflowCatalogService();

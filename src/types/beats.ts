export interface SuggestedAction {
    label: string;
    icon?: string;
    payload: {
      action: 'open_tool';
      tool: string;
      params: any;
    };
  }
  
  export interface BeatUIJSON {
    id: string;
    type: string;
    prompt: string;
    suggestedActions: SuggestedAction[];
    timestamp: string;
  }
  
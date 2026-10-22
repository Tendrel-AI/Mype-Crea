export interface BrandAssets { name: string; profile: string; logoUrl: string; labelUrl: string; landingPage: string; typedLandingPage?: unknown; marketingPlan: string; }
export interface Message { id: string; role: 'user' | 'model'; text: string; isImage?: boolean; imageUrl?: string; imageAssetKey?: 'logoUrl' | 'labelUrl'; isSystem?: boolean; isNotice?: boolean; }
export type Tab = 'create' | 'gallery' | 'landing';
export type Step = 1 | 2 | 3 | 4 | 5 | 6;

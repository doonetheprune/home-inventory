/**
 * Talks to the Larder REST API. Paths are relative so the app works behind
 * Home Assistant ingress and reverse proxies.
 */
import type {
  Category, Dashboard, IdentifyResult, PlaceContents, PlaceNodeT, PlaceRef, Place, Product, ProductCreate, ProductDetail, ProductSummary,
  SearchSectionResult, Shop, ShoppingList, ShoppingSummary, Variant, Delivery, Movement, HouseholdSettings, ModuleInfo, Purchase,
} from '@larder/core';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

type Listener = () => void;
const authListeners = new Set<Listener>();
export const onAuthRequired = (l: Listener) => {
  authListeners.add(l);
  return () => {
    authListeners.delete(l);
  };
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Larder-Client': 'web' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`api/v1${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError("Can't reach Larder. Check your connection and that the server is running.", 0, 'offline');
  }
  if (res.status === 401 && !path.startsWith('/auth/')) authListeners.forEach((l) => l());
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (data ?? {}) as { message?: string; error?: string };
    throw new ApiError(e.message ?? `Larder answered ${res.status}.`, res.status, e.error ?? 'error');
  }
  return data as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {});
const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
const put = <T>(p: string, b: unknown) => request<T>('PUT', p, b);
const del = <T>(p: string) => request<T>('DELETE', p);
const qs = (o: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : '';
};

export interface AuthUser { id: string; username: string; displayName: string; role: 'admin' | 'member'; via: 'session' | 'token' | 'none' | 'ingress' }
export interface AuthStatus { mode: 'local' | 'none' | 'homeassistant'; setupNeeded: boolean; user: AuthUser | null; version: string }
export interface TokenInfo { id: string; name: string; prefix: string; userId: string; createdAt: string; lastUsedAt: string | null }
export interface NfcScan { tagId: string; at: string; device: string | null; kind: 'product' | 'place' | 'unknown'; id: string | null; name: string | null }
export interface ServerInfo { version: string; auth: string; storage: string; baseUrl: string | null; dataDir: string; backups: boolean; demo: boolean }

export const api = {
  raw: request,
  auth: {
    status: () => get<AuthStatus>('/auth/status'),
    setup: (b: { username: string; password: string; displayName?: string }) => post<AuthUser>('/auth/setup', b),
    login: (b: { username: string; password: string }) => post<AuthUser>('/auth/login', b),
    logout: () => post('/auth/logout'),
    password: (b: { currentPassword: string; newPassword: string }) => post('/auth/password', b),
    users: () => get<AuthUser[]>('/auth/users'),
    addUser: (b: { username: string; password: string; role: 'admin' | 'member' }) => post<AuthUser>('/auth/users', b),
    removeUser: (id: string) => del(`/auth/users/${id}`),
    tokens: () => get<TokenInfo[]>('/auth/tokens'),
    createToken: (name: string) => post<{ token: string; info: TokenInfo }>('/auth/tokens', { name }),
    removeToken: (id: string) => del(`/auth/tokens/${id}`),
  },
  home: () => get<Dashboard>('/home'),
  search: (q: string) => get<{ sections: SearchSectionResult[] }>(`/search${qs({ q })}`),
  categories: {
    list: () => get<Category[]>('/categories'),
    create: (b: Partial<Category>) => post<Category>('/categories', b),
    update: (id: string, b: Partial<Category>) => patch<Category>(`/categories/${id}`, b),
    remove: (id: string) => del(`/categories/${id}`),
  },
  shops: {
    list: () => get<Shop[]>('/shops'),
    presets: () => get<Array<{ name: string; sells: string[] }>>('/shops/presets'),
    addPreset: (name: string) => post<Shop>('/shops/presets', { name }),
    create: (b: Partial<Shop>) => post<Shop>('/shops', b),
    update: (id: string, b: Partial<Shop>) => patch<Shop>(`/shops/${id}`, b),
    remove: (id: string) => del(`/shops/${id}`),
  },
  places: {
    list: () => get<PlaceRef[]>('/places'),
    tree: () => get<PlaceNodeT[]>('/places/tree'),
    contents: (id: string) => get<PlaceContents>(`/places/${id}`),
    create: (b: { name: string; parentId?: string | null; code?: string | null; notes?: string }) => post<Place>('/places', b),
    update: (id: string, b: Partial<Place>) => patch<Place>(`/places/${id}`, b),
    remove: (id: string) => del(`/places/${id}`),
    grid: (b: { parentId: string | null; name: string; prefix: string; rows: number; columns: number; firstRow: 'top' | 'bottom' }) => post<{ container: Place; places: Place[] }>('/places/grid', b),
  },
  products: {
    list: (filter: { status?: string; categoryId?: string; placeId?: string } = {}) => get<ProductSummary[]>(`/products${qs(filter)}`),
    get: (id: string) => get<ProductDetail>(`/products/${id}`),
    create: (b: ProductCreate) => post<Product>('/products', b),
    update: (id: string, b: Partial<ProductCreate>) => patch<Product>(`/products/${id}`, b),
    remove: (id: string) => del(`/products/${id}`),
    setOnList: (id: string, onShoppingList: boolean) => put<Product>(`/products/${id}/shopping-list`, { onShoppingList }),
    addVariant: (id: string, b: Partial<Variant>) => post<Variant>(`/products/${id}/variants`, b),
    updateVariant: (id: string, b: Partial<Variant>) => patch<Variant>(`/variants/${id}`, b),
    removeVariant: (id: string) => del(`/variants/${id}`),
    renew: (id: string) => post<ProductSummary>(`/products/${id}/renew`),
  },
  stock: {
    add: (b: { productId: string; quantity: number; placeId?: string | null; expiresOn?: string | null; variantId?: string | null }) => post<ProductSummary>('/stock/add', b),
    use: (b: { productId: string; quantity: number; placeId?: string }) => post<ProductSummary>('/stock/use', b),
    move: (b: { productId: string; toPlaceId: string; quantity?: number; fromPlaceId?: string; mode: 'temporary' | 'permanent' }) => post<ProductSummary>('/stock/move', b),
    returnHome: (b: { productId: string; entryId?: string }) => post<ProductSummary>('/stock/return', b),
    charge: (b: { productId: string; quantity: number }) => post<ProductSummary>('/stock/charge', b),
    expect: (b: { productId: string; quantity: number; source: string; eta?: string | null }) => post<ProductSummary>('/stock/expect', b),
    arrive: (b: { source?: string; entryIds?: string[]; productId?: string; quantity?: number }) => post<{ arrived: number; products: ProductSummary[] }>('/stock/arrive', b),
    deliveries: () => get<Delivery[]>('/stock/deliveries'),
    updateEntry: (id: string, b: { quantity?: number; expiresOn?: string | null; placeId?: string | null; currentPlaceId?: string | null }) => patch<ProductSummary>(`/stock/entries/${id}`, b),
    removeEntry: (id: string) => del<ProductSummary>(`/stock/entries/${id}`),
  },
  shopping: {
    summary: () => get<ShoppingSummary>('/shopping'),
    forShop: (id: string) => get<ShoppingList>(`/shopping/${id}`),
    unassigned: () => get<ShoppingList['groups']>('/shopping/unassigned'),
    purchase: (b: Purchase) => post<ProductSummary[]>('/shopping/purchase', b),
  },
  identify: (code: string) => get<IdentifyResult>(`/identify${qs({ code })}`),
  remember: (b: { barcode: string; productId?: string; create?: ProductCreate; variantName?: string; imageUrl?: string | null; source?: string }) =>
    post<{ product: ProductSummary; variant: Variant }>('/identify/remember', b),
  history: (limit = 50) => get<Movement[]>(`/history${qs({ limit })}`),
  settings: {
    get: () => get<HouseholdSettings>('/settings'),
    update: (b: Partial<HouseholdSettings>) => patch<HouseholdSettings>('/settings', b),
    server: () => get<ServerInfo>('/settings/server'),
    backup: () => post<{ file: string }>('/settings/backup'),
    demo: () => post<{ products: number }>('/settings/demo'),
  },
  modules: {
    list: () => get<ModuleInfo[]>('/modules'),
    setEnabled: (id: string, enabled: boolean) => patch<ModuleInfo>(`/modules/${id}`, { enabled }),
    call: <T>(id: string, method: string, path: string, body?: unknown) => request<T>(method, `/modules/${id}${path === '/' ? '' : path}`, body),
  },
  oauth: {
    request: (id: string) => get<{ client: string; redirectHost: string }>(`/oauth/requests/${encodeURIComponent(id)}`),
    answer: (id: string, approve: boolean) => post<{ redirect: string }>(`/oauth/requests/${encodeURIComponent(id)}`, { approve }),
  },
  nfc: {
    recent: () => get<NfcScan[]>('/nfc/recent'),
    scanned: (b: { tagId: string; device?: string }) => post<NfcScan & { path: string | null }>('/nfc/scanned', b),
    link: (b: { tagId: string; productId?: string; placeId?: string }) => post<{ kind: 'product' | 'place' }>('/nfc/link', b),
    unlink: (tagId: string) => del<{ unlinked: boolean }>(`/nfc/tags/${encodeURIComponent(tagId)}`),
  },
  files: {
    upload: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return request<{ id: string }>('POST', '/files', fd);
    },
    url: (id: string) => `api/v1/files/${id}`,
  },
};

import 'dotenv/config';

type Sale = {
  priceJpy: number;
  soldAt: string;
  condition: 'raw' | 'graded';
  grade?: string;
  title: string;
  url?: string;
};

type EbayItem = { title?: string; itemWebUrl?: string; image?: { imageUrl?: string }; price?: { value?: string; currency?: string }; marketplace?: string };

function classify(title: string): { condition: 'raw' | 'graded'; grade?: string } {
  const upper = title.toUpperCase();
  const match = upper.match(/\b(?:PSA|BGS|CGC|SGC)\s*(\d+(?:\.\d+)?)\b/);
  return match ? { condition: 'graded', grade: `${upper.match(/PSA|BGS|CGC|SGC/)?.[0]} ${match[1]}` } : { condition: 'raw' };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export async function currentJpyToEur(): Promise<number> {
  const url = process.env.EXCHANGE_RATE_API_URL ?? 'https://open.er-api.com/v6/latest/JPY';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Taux de change indisponible (${response.status})`);
  const data = await response.json() as { rates?: { EUR?: number } };
  const rate = data.rates?.EUR;
  if (!rate) throw new Error('Le taux JPY/EUR est absent de la réponse.');
  return rate;
}

export async function ebayApplicationToken(): Promise<string> {
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('EBAY_CLIENT_ID ou EBAY_CLIENT_SECRET manquant dans .env');
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`eBay refuse l'authentification (${response.status}) : ${details.slice(0, 300)}`);
  }
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error('eBay n’a pas renvoyé de jeton.');
  return data.access_token;
}

export async function searchEbay(reference: string, token: string, marketplace = 'EBAY_BOTH') {
  const japaneseNames: Record<string, string> = { 'ミュウ': 'Mew', 'ミュウツー': 'Mewtwo', 'ピカチュウ': 'Pikachu', 'リザードン': 'Charizard', 'ブラッキー': 'Umbreon', 'ゲンガー': 'Gengar', 'イーブイ': 'Eevee' };
  const queries = /[\u3040-\u30ff\u3400-\u9fff]/.test(reference)
    ? [reference, japaneseNames[reference] ?? reference]
    : [`Pokemon Japanese ${reference}`];
  const marketplaces = marketplace === 'EBAY_BOTH' ? ['EBAY_FR', 'EBAY_US'] : [marketplace];
  const usdRate = marketplaces.includes('EBAY_US') ? await (async () => {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await response.json() as { rates?: { EUR?: number } };
    return data.rates?.EUR ?? 0.92;
  })() : 1;
  const responses = await Promise.all(marketplaces.flatMap(currentMarketplace => queries.map(async query => {
    const params = new URLSearchParams({ q: query, limit: '50' });
    const response = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplace } });
    if (!response.ok) throw new Error(`Recherche eBay impossible (${response.status})`);
    const data = await response.json() as { itemSummaries?: EbayItem[] };
    return (data.itemSummaries ?? []).map(item => {
      const isUsd = item.price?.currency === 'USD';
      return { ...item, marketplace: currentMarketplace, title: `${currentMarketplace === 'EBAY_US' ? '🇺🇸' : '🇫🇷'} ${item.title ?? ''}`, price: isUsd ? { value: String(Number(item.price?.value ?? 0) * usdRate), currency: 'EUR' } : item.price };
    });
  })));
  const unique = new Map<string, EbayItem>();
  responses.flat().forEach(item => unique.set(item.itemWebUrl ?? item.title ?? String(unique.size), item));
  return [...unique.values()];
}

export function summarize(sales: Sale[], jpyToEur: number) {
  const groups = new Map<string, number[]>();
  for (const sale of sales) {
    const key = sale.condition === 'raw' ? 'raw' : (sale.grade ?? 'graded-unknown');
    const values = groups.get(key) ?? [];
    values.push(sale.priceJpy);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([group, prices]) => {
    const medianJpy = median(prices)!;
    return { group, sales: prices.length, medianJpy, medianEur: medianJpy * jpyToEur };
  });
}

async function main() {
  const rate = await currentJpyToEur();
  console.log(`Taux actuel: 1 JPY = ${rate.toFixed(6)} EUR`);
  const token = await ebayApplicationToken();
  console.log('Connexion eBay réussie.');
  const reference = process.argv[2];
  if (!reference) {
    console.log('Utilisation : npm run dev -- 040/141');
    return;
  }
  const items = await searchEbay(reference, token);
  if (!items.length) { console.log(`Aucune annonce trouvée pour ${reference}.`); return; }
  for (const item of items) {
    const title = item.title ?? '(sans titre)';
    const category = classify(title);
    const value = Number(item.price?.value ?? 0);
    const currency = item.price?.currency ?? '';
    console.log(`[${category.condition}${category.grade ? ` ${category.grade}` : ''}] ${value} ${currency} — ${title}`);
    if (item.itemWebUrl) console.log(`  ${item.itemWebUrl}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error); process.exitCode = 1; });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  const debug = {
    env: {
      SUPABASE_URL_set: !!supabaseUrl,
      SUPABASE_KEY_set: !!supabaseKey,
      SUPABASE_URL_value: supabaseUrl ? supabaseUrl.substring(0, 40) + '...' : 'NOT SET',
      SUPABASE_KEY_prefix: supabaseKey ? supabaseKey.substring(0, 20) + '...' : 'NOT SET',
    },
    tests: []
  };

  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({ debug, error: 'Missing env vars' });
  }

  // Test 1: Raw count of all approved products
  try {
    const r1 = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?approved=eq.true&select=count`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'count=exact',
          'Range-Unit': 'items',
          'Range': '0-0',
        }
      }
    );
    const count = r1.headers.get('content-range');
    const body = await r1.text();
    debug.tests.push({
      test: 'Count approved products',
      status: r1.status,
      content_range: count,
      body_sample: body.substring(0, 200),
    });
  } catch(e) {
    debug.tests.push({ test: 'Count approved products', error: e.message });
  }

  // Test 2: Fetch first 3 products to see what names look like
  try {
    const r2 = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?approved=eq.true&limit=3&select=product_name,approved`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        }
      }
    );
    const body2 = await r2.json();
    debug.tests.push({
      test: 'First 3 product names',
      status: r2.status,
      products: body2,
    });
  } catch(e) {
    debug.tests.push({ test: 'First 3 product names', error: e.message });
  }

  // Test 3: Search for kidney using * wildcard
  try {
    const r3 = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?approved=eq.true&product_name=ilike.*kidney*&limit=3&select=product_name`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        }
      }
    );
    const body3 = await r3.json();
    debug.tests.push({
      test: 'Search kidney with * wildcard',
      status: r3.status,
      results: body3,
    });
  } catch(e) {
    debug.tests.push({ test: 'Search kidney *', error: e.message });
  }

  // Test 4: Search for kidney using %25 encoding
  try {
    const r4 = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?approved=eq.true&product_name=ilike.%25kidney%25&limit=3&select=product_name`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        }
      }
    );
    const body4 = await r4.json();
    debug.tests.push({
      test: 'Search kidney with %25 encoding',
      status: r4.status,
      results: body4,
    });
  } catch(e) {
    debug.tests.push({ test: 'Search kidney %25', error: e.message });
  }

  // Test 5: Search without any filter — just get any product
  try {
    const r5 = await fetch(
      `${supabaseUrl}/rest/v1/sol_products?limit=1&select=product_name,approved`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        }
      }
    );
    const body5 = await r5.json();
    debug.tests.push({
      test: 'Fetch any 1 product (no filter)',
      status: r5.status,
      results: body5,
    });
  } catch(e) {
    debug.tests.push({ test: 'Fetch any product', error: e.message });
  }

  return res.status(200).json(debug);
}

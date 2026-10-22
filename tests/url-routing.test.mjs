import test from 'node:test';
import assert from 'node:assert/strict';

// Helper functions reproducing the exact logic in index.html
function getUrlState(searchString) {
  const params = new URLSearchParams(searchString);
  const q = (params.get('q') || '').trim();
  const placeId = (params.get('place_id') || params.get('placeId') || '').trim();
  const drawerParam = params.get('drawer');
  const drawer = drawerParam === '1' || drawerParam === 'true';
  return { q, placeId, drawer };
}

function computeUrlStateUrl(currentPathname, currentSearch, { q, placeId, drawer }) {
  const currentParams = new URLSearchParams(currentSearch);
  const currentQuery = (currentParams.get('q') || '').trim();
  const currentPlaceId = (currentParams.get('place_id') || currentParams.get('placeId') || '').trim();
  const currentDrawer = currentParams.get('drawer') === '1' || currentParams.get('drawer') === 'true';

  const targetQ = (q !== undefined ? q : currentQuery).trim();
  const targetPlaceId = placeId !== undefined ? (placeId || '').trim() : currentPlaceId;
  const targetDrawer = drawer !== undefined ? Boolean(drawer) : currentDrawer;

  const newParams = new URLSearchParams();
  if (targetQ) {
    newParams.set('q', targetQ);
    if (targetPlaceId) {
      newParams.set('place_id', targetPlaceId);
    }
    if (targetDrawer) {
      newParams.set('drawer', '1');
    }
  }

  const newSearch = newParams.toString();
  return newSearch ? `${currentPathname}?${newSearch}` : currentPathname;
}

function buildStoreShareUrl(origin, pathname, query, placeId, includeDrawer = false) {
  const url = new URL(origin + pathname);
  if (query) {
    url.searchParams.set('q', query.trim());
  }
  if (placeId) {
    url.searchParams.set('place_id', placeId.trim());
  }
  if (includeDrawer) {
    url.searchParams.set('drawer', '1');
  }
  return url.toString();
}

test('URL Routing - getUrlState correctly parses search params', () => {
  // Empty
  assert.deepEqual(getUrlState(''), { q: '', placeId: '', drawer: false });
  assert.deepEqual(getUrlState('?'), { q: '', placeId: '', drawer: false });

  // Query only
  assert.deepEqual(getUrlState('?q=%E5%B7%9D%E9%86%89%E6%B9%98'), {
    q: '川醉湘',
    placeId: '',
    drawer: false
  });

  // Query and place_id
  assert.deepEqual(getUrlState('?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJ123456789'), {
    q: '川醉湘',
    placeId: 'ChIJ123456789',
    drawer: false
  });

  // Query, place_id and drawer=1
  assert.deepEqual(getUrlState('?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJ123456789&drawer=1'), {
    q: '川醉湘',
    placeId: 'ChIJ123456789',
    drawer: true
  });

  // Query, place_id and drawer=true
  assert.deepEqual(getUrlState('?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJ123456789&drawer=true'), {
    q: '川醉湘',
    placeId: 'ChIJ123456789',
    drawer: true
  });

  // Support placeId fallback parameter
  assert.deepEqual(getUrlState('?q=test&placeId=fallbackId'), {
    q: 'test',
    placeId: 'fallbackId',
    drawer: false
  });
});

test('URL Routing - computeUrlStateUrl builds clean URLs', () => {
  const pathname = '/';

  // 1. Initial search
  const url1 = computeUrlStateUrl(pathname, '', { q: '川醉湘' });
  assert.equal(url1, '/?q=%E5%B7%9D%E9%86%89%E6%B9%98');

  // 2. Select store card
  const url2 = computeUrlStateUrl(pathname, '?q=%E5%B7%9D%E9%86%89%E6%B9%98', { placeId: 'ChIJabc' });
  assert.equal(url2, '/?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJabc');

  // 3. Open drawer
  const url3 = computeUrlStateUrl(pathname, '?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJabc', { drawer: true });
  assert.equal(url3, '/?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJabc&drawer=1');

  // 4. Close drawer
  const url4 = computeUrlStateUrl(pathname, '?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJabc&drawer=1', { drawer: false });
  assert.equal(url4, '/?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJabc');

  // 5. Reset to home (q = '')
  const url5 = computeUrlStateUrl(pathname, '?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJabc', { q: '' });
  assert.equal(url5, '/');
});

test('URL Routing - buildStoreShareUrl creates exact shareable links', () => {
  const origin = 'https://storepulse.david888.com';
  const pathname = '/';

  // Card share link
  const cardUrl = buildStoreShareUrl(origin, pathname, '川醉湘', 'ChIJ987654321', false);
  assert.equal(cardUrl, 'https://storepulse.david888.com/?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJ987654321');

  // Drawer share link
  const drawerUrl = buildStoreShareUrl(origin, pathname, '川醉湘', 'ChIJ987654321', true);
  assert.equal(drawerUrl, 'https://storepulse.david888.com/?q=%E5%B7%9D%E9%86%89%E6%B9%98&place_id=ChIJ987654321&drawer=1');
});

test('URL Routing - handles single quotes, double quotes, ampersands, spaces, and direct place_id', () => {
  const origin = 'https://storepulse.david888.com';
  const pathname = '/';

  // Direct place_id without query
  const directState = getUrlState('?place_id=ChIJdirect123&drawer=1');
  assert.deepEqual(directState, {
    q: '',
    placeId: 'ChIJdirect123',
    drawer: true
  });

  // Store name with single quote (McDonald's)
  const mcdUrl = buildStoreShareUrl(origin, pathname, "McDonald's 台北光復店", 'ChIJMcd123', false);
  assert.ok(mcdUrl.includes("q=McDonald%27s"));
  const parsedMcd = getUrlState(new URL(mcdUrl).search);
  assert.equal(parsedMcd.q, "McDonald's 台北光復店");
  assert.equal(parsedMcd.placeId, "ChIJMcd123");

  // Store name with double quotes, ampersands, and pluses
  const complexName = 'Ben & Jerry’s "Ice + Cream" 旗艦店';
  const complexUrl = buildStoreShareUrl(origin, pathname, complexName, 'ChIJComplex', true);
  const parsedComplex = getUrlState(new URL(complexUrl).search);
  assert.equal(parsedComplex.q, complexName);
  assert.equal(parsedComplex.placeId, 'ChIJComplex');
  assert.equal(parsedComplex.drawer, true);
});

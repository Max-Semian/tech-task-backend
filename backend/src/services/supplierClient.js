// HTTP-клиент для обращения к поставщикам выдачи (контракт из ТЗ: POST /issue)

export async function callSupplier({ url, requestId, sku, orderId, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, sku, order_id: orderId }),
      signal: controller.signal,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* тело не JSON — воспринимаем как ошибку http */
    }
    if (res.ok && data.status === 'ok' && data.code) {
      return { kind: 'ok', code: data.code };
    }
    if (data.reason === 'out_of_stock') {
      return { kind: 'out_of_stock', status: res.status };
    }
    if (res.status >= 400 && res.status < 500) {
      return { kind: 'error', status: res.status, reason: data.reason || 'http_4xx' };
    }
    return { kind: 'error', status: res.status, reason: data.reason || `http_${res.status}` };
  } catch (err) {
    if (err.name === 'AbortError') {
      // Таймаут != отказ: поставщик мог успеть выдать код, но ответ не дошёл.
      // Повтор должен идти с тем же request_id.
      return { kind: 'timeout' };
    }
    return { kind: 'error', reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function restockSupplier(url, sku, codes, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/restock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku, codes }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSupplierStock(url, sku, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/stock?sku=${encodeURIComponent(sku)}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.available ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

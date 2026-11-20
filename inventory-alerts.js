function roundQty(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function evaluateInventoryStock(item) {
  const stockQty = Math.max(0, roundQty(item?.stockQty ?? 0));
  const reorderLevel = Math.max(0, roundQty(item?.reorderLevel ?? 0));
  const costPerUnit = Math.max(0, roundQty(item?.costPerUnit ?? 0));
  const unit = String(item?.unit || 'units').trim() || 'units';

  let status = 'healthy';
  let severity = 'ok';

  if (stockQty <= 0) {
    status = 'out_of_stock';
    severity = 'critical';
  } else if (stockQty <= reorderLevel) {
    status = 'low_stock';
    severity = stockQty <= reorderLevel * 0.5 ? 'critical' : 'warning';
  }

  const needsReorder = status === 'out_of_stock' || status === 'low_stock';
  const deficit = needsReorder ? Math.max(0, roundQty(reorderLevel - stockQty)) : 0;
  const targetQty = Math.max(1, Math.ceil(reorderLevel * 2));
  const recommendedReorderQty = needsReorder ? Math.max(1, Math.ceil(targetQty - stockQty)) : 0;
  const estimatedRestockCost = roundQty(recommendedReorderQty * costPerUnit);

  const isAcknowledged =
    needsReorder &&
    item?.acknowledgedAtStockQty !== null &&
    item?.acknowledgedAtStockQty !== undefined &&
    stockQty >= Number(item.acknowledgedAtStockQty);

  let message = `Stock healthy (${stockQty} ${unit} vs ${reorderLevel} ${unit} threshold).`;
  if (status === 'out_of_stock') {
    message = `Out of stock (0 ${unit}). Threshold is ${reorderLevel} ${unit}; reorder +${recommendedReorderQty} ${unit}.`;
  } else if (status === 'low_stock') {
    message = `${stockQty} ${unit} remaining (threshold: ${reorderLevel} ${unit}). Suggested reorder: +${recommendedReorderQty} ${unit}.`;
  }

  return {
    id: item?.id || '',
    name: item?.name || 'Ingredient',
    sku: item?.sku || '',
    unit,
    stockQty,
    reorderLevel,
    costPerUnit,
    status,
    severity,
    needsReorder,
    isAcknowledged,
    deficit,
    recommendedReorderQty,
    estimatedRestockCost,
    message,
    lowStockAlertAt: item?.lowStockAlertAt || item?.updatedAt || null,
  };
}

export function buildLowStockNotifications(inventory = []) {
  const evaluated = (Array.isArray(inventory) ? inventory : []).map(evaluateInventoryStock);
  const allAlerts = evaluated
    .filter((entry) => entry.needsReorder)
    .sort((a, b) => {
      if (a.status === 'out_of_stock' && b.status !== 'out_of_stock') return -1;
      if (b.status === 'out_of_stock' && a.status !== 'out_of_stock') return 1;
      const ratioA = a.reorderLevel > 0 ? a.stockQty / a.reorderLevel : 0;
      const ratioB = b.reorderLevel > 0 ? b.stockQty / b.reorderLevel : 0;
      return ratioA - ratioB;
    });

  const activeAlerts = allAlerts.filter((entry) => !entry.isAcknowledged);
  const criticalCount = allAlerts.filter((entry) => entry.severity === 'critical').length;
  const warningCount = allAlerts.filter((entry) => entry.severity === 'warning').length;
  const totalEstimatedRestockCost = roundQty(
    allAlerts.reduce((sum, entry) => sum + entry.estimatedRestockCost, 0)
  );

  return {
    allAlerts,
    activeAlerts,
    totalAlertCount: allAlerts.length,
    activeAlertCount: activeAlerts.length,
    criticalCount,
    warningCount,
    totalEstimatedRestockCost,
  };
}

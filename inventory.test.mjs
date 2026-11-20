import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLowStockNotifications, evaluateInventoryStock } from './inventory-alerts.js';

test('evaluateInventoryStock classifies out_of_stock, low_stock, and healthy states accurately', () => {
  const criticalEmpty = evaluateInventoryStock({
    id: 'inv-1',
    name: 'Oat Milk',
    sku: 'KRD-201',
    unit: 'liters',
    stockQty: 0,
    reorderLevel: 10,
    costPerUnit: 180,
  });
  assert.equal(criticalEmpty.status, 'out_of_stock');
  assert.equal(criticalEmpty.severity, 'critical');
  assert.equal(criticalEmpty.needsReorder, true);
  assert.equal(criticalEmpty.deficit, 10);
  assert.equal(criticalEmpty.recommendedReorderQty, 20);
  assert.equal(criticalEmpty.estimatedRestockCost, 3600);

  const criticalHalf = evaluateInventoryStock({
    id: 'inv-2',
    name: 'Arabica Beans',
    sku: 'KRD-202',
    unit: 'kg',
    stockQty: 4,
    reorderLevel: 10,
    costPerUnit: 950,
  });
  assert.equal(criticalHalf.status, 'low_stock');
  assert.equal(criticalHalf.severity, 'critical');
  assert.equal(criticalHalf.needsReorder, true);
  assert.equal(criticalHalf.recommendedReorderQty, 16);

  const warningItem = evaluateInventoryStock({
    id: 'inv-3',
    name: 'Puff Pastry Sheets',
    sku: 'KRD-203',
    unit: 'packs',
    stockQty: 9,
    reorderLevel: 10,
    costPerUnit: 180,
  });
  assert.equal(warningItem.status, 'low_stock');
  assert.equal(warningItem.severity, 'warning');
  assert.equal(warningItem.needsReorder, true);
  assert.equal(warningItem.recommendedReorderQty, 11);

  const healthyItem = evaluateInventoryStock({
    id: 'inv-4',
    name: 'Cultured Butter',
    sku: 'KRD-204',
    unit: 'kg',
    stockQty: 25,
    reorderLevel: 10,
    costPerUnit: 500,
  });
  assert.equal(healthyItem.status, 'healthy');
  assert.equal(healthyItem.severity, 'ok');
  assert.equal(healthyItem.needsReorder, false);
  assert.equal(healthyItem.recommendedReorderQty, 0);
});

test('buildLowStockNotifications ranks critical alerts first and tracks acknowledged dismissals', () => {
  const summary = buildLowStockNotifications([
    { id: 'healthy', name: 'Sugar', sku: 'S-1', unit: 'kg', stockQty: 40, reorderLevel: 10, costPerUnit: 50 },
    { id: 'warn-ack', name: 'Chai Leaf', sku: 'C-1', unit: 'packs', stockQty: 8, reorderLevel: 10, costPerUnit: 180, acknowledgedAtStockQty: 8 },
    { id: 'crit-zero', name: 'Cream Cheese', sku: 'CC-1', unit: 'kg', stockQty: 0, reorderLevel: 6, costPerUnit: 400 },
    { id: 'warn-new', name: 'Pistachio', sku: 'P-1', unit: 'kg', stockQty: 7, reorderLevel: 8, costPerUnit: 900 },
  ]);

  assert.equal(summary.totalAlertCount, 3);
  assert.equal(summary.activeAlertCount, 2);
  assert.equal(summary.criticalCount, 1);
  assert.equal(summary.warningCount, 2);
  assert.equal(summary.allAlerts[0].id, 'crit-zero');
  assert.equal(summary.activeAlerts.some((a) => a.id === 'warn-ack'), false);

  // If acknowledged item drops further below acknowledgedAtStockQty, it automatically becomes active again
  const retriggered = buildLowStockNotifications([
    { id: 'warn-ack', name: 'Chai Leaf', sku: 'C-1', unit: 'packs', stockQty: 6, reorderLevel: 10, costPerUnit: 180, acknowledgedAtStockQty: 8 },
  ]);
  assert.equal(retriggered.activeAlertCount, 1);
  assert.equal(retriggered.activeAlerts[0].isAcknowledged, false);
});

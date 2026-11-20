import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { validateBooking } from './booking.js';
import { buildLowStockNotifications, evaluateInventoryStock } from './inventory-alerts.js';
import {
  computeDailySpecialSavingsPct,
  createDailySpecialWindow,
  formatDailySpecialRemaining,
  isDailySpecialActive,
} from './daily-specials.js';
import {
  FLOOR_PLAN_TABLES,
  findFloorPlanTableMeta,
  normalizeTableLabel,
  tableLabelToId,
} from './qr-tools.js';
import { computeLoyaltyAnalytics } from './loyalty-analytics.js';

export const OWNER_EMAIL = 'krishnaladva25@gmail.com';
export const ORDER_STATUSES = ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];
export const RESERVATION_STATUSES = ['confirmed', 'seated', 'completed', 'cancelled'];
export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'];

export const FOOD_TAXONOMY = {
  Coffee: [
    'Espresso',
    'Double Espresso',
    'Americano',
    'Cappuccino',
    'Café Latte',
    'Flat White',
    'Mocha',
    'Macchiato',
    'Caramel Macchiato',
    'Vanilla Latte',
    'Hazelnut Latte',
    'Spanish Latte',
    'Iced Americano',
    'Iced Latte',
    'Iced Mocha',
    'Cold Coffee',
    'Cold Brew',
    'Vietnamese Coffee',
  ],
  Croissants: [
    'Classic Butter Croissant',
    'Chocolate Croissant',
    'Almond Croissant',
    'Strawberry Croissant',
    'Blueberry Croissant',
    'Pistachio Croissant',
    'Nutella Croissant',
    'Cheese Croissant',
    'Garlic Croissant',
    'Cream Cheese Croissant',
    'Chicken Croissant',
    'Mushroom Croissant',
  ],
  'Bakery & Desserts': [
    'Chocolate Muffin',
    'Blueberry Muffin',
    'Cinnamon Roll',
    'Brownies',
    'Cheesecake',
    'Tiramisu',
    'Cookies',
    'Danish Pastry',
  ],
};

export const SHOWCASE_SECTIONS = [
  'Bestselling Coffees',
  'Hot Coffee',
  'Cold Coffee',
  'Speciality Coffee',
  'Classic Croissants',
  'Chocolate & Nut Croissants',
  'Fruit Croissants',
  'Savory Croissants',
  'Bakery & Desserts',
];

const IMG_HOT_COFFEE = '/src/assets/optimized/hot-coffee.webp';
const IMG_COLD_COFFEE = '/src/assets/optimized/cold-coffee.webp';
const IMG_CLASSIC_CROISSANT = '/src/assets/optimized/classic-croissant.webp';
const IMG_CHOC_NUT_CROISSANT = '/src/assets/optimized/choc-nut-croissant.webp';
const IMG_FRUIT_SAVORY_CROISSANT = '/src/assets/optimized/fruit-savory-croissant.webp';
const IMG_BAKERY_DESSERTS = '/src/assets/optimized/bakery-desserts.webp';

const COFFEE_HOT_CUSTOMISATIONS = [
  { name: 'Cup Size', choices: ['Single / Regular', 'Large'] },
  { name: 'Milk Choice', choices: ['Regular Dairy', 'Oat Milk', 'Almond Milk', 'Skim Milk'] },
  { name: 'Espresso Strength', choices: ['House Balance', 'Extra Shot'] },
];

const COFFEE_COLD_CUSTOMISATIONS = [
  { name: 'Glass Size', choices: ['Regular (300ml)', 'Tall (450ml)'] },
  { name: 'Milk Choice', choices: ['Regular Dairy', 'Oat Milk', 'Almond Milk'] },
  { name: 'Ice & Sweetness', choices: ['Regular Ice', 'Less Ice', 'Unsweetened', 'Light Sweet'] },
];

const CROISSANT_CUSTOMISATIONS = [
  { name: 'Serving Style', choices: ['Served Warm', 'Crisp Room Temp'] },
  { name: 'Accompaniment', choices: ['None', 'Whipped Cultured Butter', 'Espresso Dip'] },
];

const BAKERY_CUSTOMISATIONS = [
  { name: 'Serving Style', choices: ['Fresh Plated', 'Warmed Gently'] },
  { name: 'Finish', choices: ['House Finish', 'Light Sugar Dust'] },
];

export function parseCustomisationOptions(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((group) => ({
        name: String(group?.name || '').trim().slice(0, 40),
        choices: Array.isArray(group?.choices)
          ? group.choices.map((c) => String(c).trim().slice(0, 50)).filter(Boolean).slice(0, 8)
          : String(group?.choices || '')
              .split(',')
              .map((c) => c.trim().slice(0, 50))
              .filter(Boolean)
              .slice(0, 8),
      }))
      .filter((g) => g.name && g.choices.length > 0)
      .slice(0, 6);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(/\n|\|/)
      .map((segment) => {
        const idx = segment.indexOf(':');
        if (idx === -1) return null;
        const name = segment.slice(0, idx).trim().slice(0, 40);
        const choices = segment
          .slice(idx + 1)
          .split(',')
          .map((c) => c.trim().slice(0, 50))
          .filter(Boolean)
          .slice(0, 8);
        return name && choices.length ? { name, choices } : null;
      })
      .filter(Boolean)
      .slice(0, 6);
  }
  return [];
}

function makeCafeSeedItem({
  id,
  name,
  category,
  subcategory,
  showcaseSection,
  imageUrl,
  description,
  ingredients,
  dietaryTags,
  dietaryType = 'veg',
  prepMinutes = 5,
  calories = 180,
  isBestseller = false,
  isNewArrival = false,
  isRecommended = false,
  customisationOptions = [],
}, now) {
  return {
    id,
    name,
    category,
    subcategory,
    showcaseSection,
    description,
    price: null,
    discountPrice: null,
    comboPrice: null,
    comboLabel: '',
    dietaryType,
    imageUrl,
    ingredients,
    dietaryTags,
    customisationOptions,
    prepMinutes,
    calories,
    available: true,
    stockStatus: 'in_stock',
    isPopular: isBestseller,
    isBestseller,
    isNew: isNewArrival,
    isNewArrival,
    isRecommended,
    isDailySpecial: false,
    dailySpecialPrice: null,
    dailySpecialStartedAt: null,
    dailySpecialExpiresAt: null,
    updatedAt: now,
  };
}

export function createCoffeeAndBakeryMenu(now = new Date().toISOString()) {
  return [
    // A. Coffee (18 subcategories) — prices intentionally null until owner enters INR prices
    makeCafeSeedItem({
      id: 'coffee-espresso',
      name: 'Espresso',
      category: 'Coffee',
      subcategory: 'Espresso',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Concentrated single-origin Arabica extraction crowned with thick hazelnut-hued crema.',
      ingredients: ['Single-Origin Arabica Beans', 'Filtered Water'],
      dietaryTags: ['Vegan', 'Gluten-Free', 'Bestseller'],
      prepMinutes: 3,
      calories: 5,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: [
        { name: 'Roast Profile', choices: ['House Medium-Dark', 'Single-Origin Fruity'] },
        { name: 'Sugar', choices: ['No Sugar', 'Raw Cane Side'] },
      ],
    }, now),
    makeCafeSeedItem({
      id: 'coffee-double-espresso',
      name: 'Double Espresso',
      category: 'Coffee',
      subcategory: 'Double Espresso',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Bold doppio pull delivering velvety body, roasted cacao intensity, and lingering caramel finish.',
      ingredients: ['Double Shot Arabica Espresso', 'Filtered Water'],
      dietaryTags: ['Vegan', 'Gluten-Free'],
      prepMinutes: 4,
      calories: 10,
      isRecommended: true,
      customisationOptions: [
        { name: 'Roast Profile', choices: ['House Medium-Dark', 'Single-Origin Fruity'] },
      ],
    }, now),
    makeCafeSeedItem({
      id: 'coffee-americano',
      name: 'Americano',
      category: 'Coffee',
      subcategory: 'Americano',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Freshly pulled espresso lengthened with hot spring water for a clean, aromatic cup.',
      ingredients: ['Arabica Espresso', 'Steaming Hot Water'],
      dietaryTags: ['Vegan', 'Gluten-Free'],
      prepMinutes: 4,
      calories: 10,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-cappuccino',
      name: 'Cappuccino',
      category: 'Coffee',
      subcategory: 'Cappuccino',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Equal parts rich espresso, steamed milk, and airy micro-foam dusted lightly with cocoa.',
      ingredients: ['Arabica Espresso', 'Steamed Whole Milk', 'Velvety Micro-Foam', 'Cocoa Dust'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 5,
      calories: 140,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-cafe-latte',
      name: 'Café Latte',
      category: 'Coffee',
      subcategory: 'Café Latte',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Silky steamed milk poured through balanced espresso shots with classic rosetta latte art.',
      ingredients: ['Arabica Espresso', 'Steamed Farm Milk'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 5,
      calories: 170,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-flat-white',
      name: 'Flat White',
      category: 'Coffee',
      subcategory: 'Flat White',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Double ristretto married with glossy micro-textured milk for an espresso-forward pour.',
      ingredients: ['Double Ristretto', 'Silky Micro-Foam Milk'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 5,
      calories: 130,
      isNewArrival: true,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-mocha',
      name: 'Mocha',
      category: 'Coffee',
      subcategory: 'Mocha',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Dark Belgian chocolate ganache melted into espresso and finished with steamed milk.',
      ingredients: ['Arabica Espresso', 'Dark Chocolate Ganache', 'Steamed Milk', 'Cocoa Drizzle'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 6,
      calories: 240,
      isRecommended: true,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-macchiato',
      name: 'Macchiato',
      category: 'Coffee',
      subcategory: 'Macchiato',
      showcaseSection: 'Hot Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Traditional Italian espresso marked gently with a spoonful of sweet steamed milk foam.',
      ingredients: ['Arabica Espresso', 'Steamed Milk Foam'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 4,
      calories: 40,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-caramel-macchiato',
      name: 'Caramel Macchiato',
      category: 'Coffee',
      subcategory: 'Caramel Macchiato',
      showcaseSection: 'Speciality Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Vanilla-infused steamed milk layered beneath espresso and ribbons of burnt-sugar caramel.',
      ingredients: ['Arabica Espresso', 'Madagascar Vanilla', 'Steamed Milk', 'Salted Caramel Drizzle'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 6,
      calories: 230,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-vanilla-latte',
      name: 'Vanilla Latte',
      category: 'Coffee',
      subcategory: 'Vanilla Latte',
      showcaseSection: 'Speciality Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Creamy espresso latte perfumed with house-steeped Madagascar vanilla bean syrup.',
      ingredients: ['Arabica Espresso', 'Steamed Milk', 'Madagascar Vanilla Bean Syrup'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 5,
      calories: 210,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-hazelnut-latte',
      name: 'Hazelnut Latte',
      category: 'Coffee',
      subcategory: 'Hazelnut Latte',
      showcaseSection: 'Speciality Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Nutty roasted Piedmont hazelnut praline blended into velvety espresso and warm milk.',
      ingredients: ['Arabica Espresso', 'Roasted Hazelnut Praline', 'Steamed Milk'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 5,
      calories: 220,
      isRecommended: true,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-spanish-latte',
      name: 'Spanish Latte',
      category: 'Coffee',
      subcategory: 'Spanish Latte',
      showcaseSection: 'Speciality Coffee',
      imageUrl: IMG_HOT_COFFEE,
      description: 'Rich espresso layered over sweet condensed milk and textured dairy for a caramel-silky sip.',
      ingredients: ['Double Espresso', 'Sweetened Condensed Milk', 'Textured Milk'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 6,
      calories: 250,
      isNewArrival: true,
      isRecommended: true,
      customisationOptions: COFFEE_HOT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-iced-americano',
      name: 'Iced Americano',
      category: 'Coffee',
      subcategory: 'Iced Americano',
      showcaseSection: 'Cold Coffee',
      imageUrl: IMG_COLD_COFFEE,
      description: 'Crisp double-shot espresso poured over crystal ice and chilled water for bright acidity.',
      ingredients: ['Double Arabica Espresso', 'Chilled Water', 'Crystal Ice'],
      dietaryTags: ['Vegan', 'Gluten-Free'],
      prepMinutes: 4,
      calories: 10,
      customisationOptions: COFFEE_COLD_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-iced-latte',
      name: 'Iced Latte',
      category: 'Coffee',
      subcategory: 'Iced Latte',
      showcaseSection: 'Cold Coffee',
      imageUrl: IMG_COLD_COFFEE,
      description: 'Chilled farm milk cascaded with fresh espresso over crystal ice cubes.',
      ingredients: ['Arabica Espresso', 'Chilled Milk', 'Ice Cubes'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 4,
      calories: 150,
      isBestseller: true,
      customisationOptions: COFFEE_COLD_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-iced-mocha',
      name: 'Iced Mocha',
      category: 'Coffee',
      subcategory: 'Iced Mocha',
      showcaseSection: 'Cold Coffee',
      imageUrl: IMG_COLD_COFFEE,
      description: 'Dark chocolate espresso shaken chilled with cold milk and topped with cocoa shavings.',
      ingredients: ['Arabica Espresso', 'Belgian Cocoa Sauce', 'Chilled Milk', 'Ice'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 5,
      calories: 230,
      customisationOptions: COFFEE_COLD_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-cold-coffee',
      name: 'Cold Coffee',
      category: 'Coffee',
      subcategory: 'Cold Coffee',
      showcaseSection: 'Cold Coffee',
      imageUrl: IMG_COLD_COFFEE,
      description: 'Classic Indian café-style frothy blended cold coffee finished with a rich espresso crown.',
      ingredients: ['House Espresso Blend', 'Chilled Milk', 'Raw Sugar', 'Cream Foam'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 5,
      calories: 240,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: COFFEE_COLD_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-cold-brew',
      name: 'Cold Brew',
      category: 'Coffee',
      subcategory: 'Cold Brew',
      showcaseSection: 'Cold Coffee',
      imageUrl: IMG_COLD_COFFEE,
      description: 'Slow-steeped for 18 hours in cold water for low acidity, dark chocolate notes, and ultra-smooth body.',
      ingredients: ['Coarse-Ground Single-Origin Arabica', 'Cold Filtered Water'],
      dietaryTags: ['Vegan', 'Gluten-Free', 'New Arrival'],
      prepMinutes: 3,
      calories: 15,
      isNewArrival: true,
      isRecommended: true,
      customisationOptions: COFFEE_COLD_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'coffee-vietnamese-coffee',
      name: 'Vietnamese Coffee',
      category: 'Coffee',
      subcategory: 'Vietnamese Coffee',
      showcaseSection: 'Cold Coffee',
      imageUrl: IMG_COLD_COFFEE,
      description: 'Intense dark-roast phin brew swirled over velvety sweetened condensed milk and ice.',
      ingredients: ['Dark Roast Phin Coffee', 'Sweetened Condensed Milk', 'Crystal Ice'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 6,
      calories: 210,
      isNewArrival: true,
      isRecommended: true,
      customisationOptions: COFFEE_COLD_CUSTOMISATIONS,
    }, now),

    // B. Croissants (12 subcategories)
    makeCafeSeedItem({
      id: 'croissant-classic-butter',
      name: 'Classic Butter Croissant',
      category: 'Croissants',
      subcategory: 'Classic Butter Croissant',
      showcaseSection: 'Classic Croissants',
      imageUrl: IMG_CLASSIC_CROISSANT,
      description: '27 honeycomb-laminated layers baked golden with European cultured butter and sea salt.',
      ingredients: ['French T55 Flour', 'Cultured European Butter', 'Organic Milk', 'Sea Salt'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 6,
      calories: 290,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-chocolate',
      name: 'Chocolate Croissant',
      category: 'Croissants',
      subcategory: 'Chocolate Croissant',
      showcaseSection: 'Chocolate & Nut Croissants',
      imageUrl: IMG_CHOC_NUT_CROISSANT,
      description: 'Flaky laminated pastry folded around twin batons of 70% dark Belgian couverture chocolate.',
      ingredients: ['Laminated Butter Pastry', '70% Dark Belgian Chocolate', 'Cocoa Drizzle'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 6,
      calories: 360,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-almond',
      name: 'Almond Croissant',
      category: 'Croissants',
      subcategory: 'Almond Croissant',
      showcaseSection: 'Chocolate & Nut Croissants',
      imageUrl: IMG_CHOC_NUT_CROISSANT,
      description: 'Twice-baked butter croissant filled with toasted almond frangipane and flaked California almonds.',
      ingredients: ['Butter Croissant', 'Roasted Almond Frangipane', 'Sliced Almonds', 'Icing Sugar'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 7,
      calories: 410,
      isRecommended: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-pistachio',
      name: 'Pistachio Croissant',
      category: 'Croissants',
      subcategory: 'Pistachio Croissant',
      showcaseSection: 'Chocolate & Nut Croissants',
      imageUrl: IMG_CHOC_NUT_CROISSANT,
      description: 'Crisp French pastry piped generously with roasted pistachio mascarpone cream and crushed pistachios.',
      ingredients: ['Butter Croissant', 'Roasted Pistachio Cream', 'Crushed Green Pistachios'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 7,
      calories: 420,
      isNewArrival: true,
      isRecommended: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-nutella',
      name: 'Nutella Croissant',
      category: 'Croissants',
      subcategory: 'Nutella Croissant',
      showcaseSection: 'Chocolate & Nut Croissants',
      imageUrl: IMG_CHOC_NUT_CROISSANT,
      description: 'Warm, flaky golden croissant generously filled with rich hazelnut cocoa spread and roasted nibs.',
      ingredients: ['Butter Croissant', 'Hazelnut Cocoa Spread', 'Roasted Hazelnuts'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 6,
      calories: 430,
      isBestseller: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-strawberry',
      name: 'Strawberry Croissant',
      category: 'Croissants',
      subcategory: 'Strawberry Croissant',
      showcaseSection: 'Fruit Croissants',
      imageUrl: IMG_FRUIT_SAVORY_CROISSANT,
      description: 'Flaky pastry filled with vanilla bean diplomat cream, fresh Mahabaleshwar strawberries, and berry glaze.',
      ingredients: ['Butter Croissant', 'Vanilla Cream', 'Fresh Strawberries', 'Berry Glaze'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 6,
      calories: 350,
      isNewArrival: true,
      isRecommended: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-blueberry',
      name: 'Blueberry Croissant',
      category: 'Croissants',
      subcategory: 'Blueberry Croissant',
      showcaseSection: 'Fruit Croissants',
      imageUrl: IMG_FRUIT_SAVORY_CROISSANT,
      description: 'Golden flaky croissant layered with wild blueberry compote and silky lemon cream.',
      ingredients: ['Butter Croissant', 'Wild Blueberry Compote', 'Lemon Zest Cream'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 6,
      calories: 345,
      isNewArrival: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-cheese',
      name: 'Cheese Croissant',
      category: 'Croissants',
      subcategory: 'Cheese Croissant',
      showcaseSection: 'Savory Croissants',
      imageUrl: IMG_FRUIT_SAVORY_CROISSANT,
      description: 'Savory flaky pastry baked with aged sharp cheddar, mozzarella, and toasted herb crust.',
      ingredients: ['Butter Croissant', 'Aged Cheddar', 'Mozzarella', 'Cracked Black Pepper'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 7,
      calories: 380,
      isBestseller: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-garlic',
      name: 'Garlic Croissant',
      category: 'Croissants',
      subcategory: 'Garlic Croissant',
      showcaseSection: 'Savory Croissants',
      imageUrl: IMG_FRUIT_SAVORY_CROISSANT,
      description: 'Crisp oven-warmed croissant brushed with roasted garlic-parsley butter and parmesan flake.',
      ingredients: ['Butter Croissant', 'Roasted Garlic Butter', 'Fresh Parsley', 'Aged Cheese'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 7,
      calories: 340,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-cream-cheese',
      name: 'Cream Cheese Croissant',
      category: 'Croissants',
      subcategory: 'Cream Cheese Croissant',
      showcaseSection: 'Savory Croissants',
      imageUrl: IMG_FRUIT_SAVORY_CROISSANT,
      description: 'Buttery pastry filled with whipped chive cream cheese and topped with toasted sesame.',
      ingredients: ['Butter Croissant', 'Whipped Cream Cheese', 'Fresh Chives', 'Toasted Sesame'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 6,
      calories: 365,
      isRecommended: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-chicken',
      name: 'Chicken Croissant',
      category: 'Croissants',
      subcategory: 'Chicken Croissant',
      showcaseSection: 'Savory Croissants',
      imageUrl: IMG_FRUIT_SAVORY_CROISSANT,
      description: 'Warm butter croissant filled with herb-roasted shredded chicken, caramelised onion, and pepper aioli.',
      ingredients: ['Butter Croissant', 'Herb-Roasted Chicken', 'Caramelised Onion', 'Pepper Aioli'],
      dietaryTags: ['High-Protein'],
      dietaryType: 'non-veg',
      prepMinutes: 9,
      calories: 440,
      isRecommended: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'croissant-mushroom',
      name: 'Mushroom Croissant',
      category: 'Croissants',
      subcategory: 'Mushroom Croissant',
      showcaseSection: 'Savory Croissants',
      imageUrl: IMG_FRUIT_SAVORY_CROISSANT,
      description: 'Sautéed cremini and button mushrooms with thyme-garlic cream tucked inside flaky pastry.',
      ingredients: ['Butter Croissant', 'Roasted Cremini Mushrooms', 'Thyme Cream Sauce', 'Swiss Cheese'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 8,
      calories: 355,
      isNewArrival: true,
      customisationOptions: CROISSANT_CUSTOMISATIONS,
    }, now),

    // C. Bakery & Desserts (8 subcategories)
    makeCafeSeedItem({
      id: 'bakery-chocolate-muffin',
      name: 'Chocolate Muffin',
      category: 'Bakery & Desserts',
      subcategory: 'Chocolate Muffin',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'Double dark-cocoa bakery muffin studded with molten chocolate chunks and crisp sugar crown.',
      ingredients: ['Dutch Cocoa', 'Dark Chocolate Chunks', 'Cultured Buttermilk', 'Espresso Pinch'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 4,
      calories: 390,
      isBestseller: true,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'bakery-blueberry-muffin',
      name: 'Blueberry Muffin',
      category: 'Bakery & Desserts',
      subcategory: 'Blueberry Muffin',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'Tender sour-cream crumb bursting with whole wild blueberries and lemon streusel crumble.',
      ingredients: ['Wild Blueberries', 'Sour Cream', 'Lemon Zest', 'Butter Streusel'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 4,
      calories: 340,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'bakery-cinnamon-roll',
      name: 'Cinnamon Roll',
      category: 'Bakery & Desserts',
      subcategory: 'Cinnamon Roll',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'Pillow-soft brioche swirl baked with Ceylon cinnamon brown butter and warm vanilla bean glaze.',
      ingredients: ['Brioche Dough', 'Ceylon Cinnamon', 'Brown Butter', 'Vanilla Bean Glaze'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 6,
      calories: 420,
      isBestseller: true,
      isRecommended: true,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'bakery-brownies',
      name: 'Brownies',
      category: 'Bakery & Desserts',
      subcategory: 'Brownies',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'Dense crackle-top Belgian chocolate fudge brownie with roasted walnut crunch and sea salt.',
      ingredients: ['70% Couverture Chocolate', 'Cultured Butter', 'Cocoa Powder', 'Flaky Sea Salt'],
      dietaryTags: ['Vegetarian', 'Bestseller'],
      prepMinutes: 4,
      calories: 380,
      isBestseller: true,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'bakery-cheesecake',
      name: 'Cheesecake',
      category: 'Bakery & Desserts',
      subcategory: 'Cheesecake',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'Velvety baked New York style vanilla cheesecake set atop a spiced butter biscuit crust.',
      ingredients: ['Cream Cheese', 'Madagascar Vanilla', 'Whipped Cream', 'Butter Biscuit Base'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 4,
      calories: 410,
      isRecommended: true,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'bakery-tiramisu',
      name: 'Tiramisu',
      category: 'Bakery & Desserts',
      subcategory: 'Tiramisu',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'House espresso-soaked savoiardi layered with airy mascarpone mousse and bitter cacao dust.',
      ingredients: ['Mascarpone Cream', 'Espresso-Soaked Savoiardi', 'Cocoa Powder', 'Vanilla'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 4,
      calories: 370,
      isNewArrival: true,
      isRecommended: true,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'bakery-cookies',
      name: 'Cookies',
      category: 'Bakery & Desserts',
      subcategory: 'Cookies',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'Chewy-edged brown-butter dark chocolate chunk cookies finished with flaky Maldon salt.',
      ingredients: ['Brown Butter', 'Dark Chocolate Chunks', 'Demerara Sugar', 'Maldon Salt'],
      dietaryTags: ['Vegetarian'],
      prepMinutes: 3,
      calories: 260,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
    makeCafeSeedItem({
      id: 'bakery-danish-pastry',
      name: 'Danish Pastry',
      category: 'Bakery & Desserts',
      subcategory: 'Danish Pastry',
      showcaseSection: 'Bakery & Desserts',
      imageUrl: IMG_BAKERY_DESSERTS,
      description: 'Crisp laminated danish crowned with vanilla custard and seasonal caramelized orchard fruit.',
      ingredients: ['Laminated Danish Dough', 'Vanilla Bean Custard', 'Seasonal Fruit Glaze'],
      dietaryTags: ['Vegetarian', 'New Arrival'],
      prepMinutes: 5,
      calories: 330,
      isNewArrival: true,
      customisationOptions: BAKERY_CUSTOMISATIONS,
    }, now),
  ];
}

export function createSeedMenu() {
  const now = new Date().toISOString();
  const baseMenu = [
    {
      id: 'crispy-grill-wrap',
      name: 'Crispy Grill Wrap',
      category: 'Wraps & Snacks',
      subcategory: 'Signature Wraps',
      showcaseSection: 'Signature Menu',
      description: 'Tender crispy patty wrapped with fresh lettuce, aged cheddar, and smoky house sauce.',
      price: 249,
      discountPrice: null,
      comboPrice: 319,
      comboLabel: 'Wrap + Piri Piri Fries + Chilled Cola',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/wrap-fries.webp',
      ingredients: ['Herb Crispy Patty', 'Romaine Lettuce', 'Aged Cheddar', 'Smoky House Sauce', 'Warm Tortilla'],
      dietaryTags: ['Signature', 'Vegetarian'],
      customisationOptions: [{ name: 'Spice Level', choices: ['Classic', 'Extra Smoky'] }],
      prepMinutes: 10,
      calories: 490,
      available: true,
      stockStatus: 'in_stock',
      isPopular: true,
      isBestseller: true,
      isNew: false,
      isNewArrival: false,
      isRecommended: true,
      updatedAt: now,
    },
    {
      id: 'roasted-black-coffee',
      name: 'Roasted Black Coffee',
      category: 'Beverages',
      subcategory: 'Filter Brew',
      showcaseSection: 'Hot Coffee',
      description: 'Freshly brewed dark roast single-origin coffee served piping hot with rich cacao aroma.',
      price: 129,
      discountPrice: null,
      comboPrice: 219,
      comboLabel: 'Black Coffee + Classic Butter Croissant',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/black-coffee.webp',
      ingredients: ['Dark Roast Arabica Beans', 'Filtered Spring Water'],
      dietaryTags: ['Vegan', 'Gluten-Free'],
      customisationOptions: [{ name: 'Strength', choices: ['Regular', 'Bold'] }],
      prepMinutes: 4,
      calories: 10,
      available: true,
      stockStatus: 'in_stock',
      isPopular: true,
      isBestseller: true,
      isNew: false,
      isNewArrival: false,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'jalapeno-cheese-burger',
      name: 'Jalapeño Cheese Burger',
      category: 'Burgers',
      subcategory: 'Artisan Burgers',
      showcaseSection: 'Signature Menu',
      description: 'Crispy golden patty topped with melted cheddar, pickled jalapeños, and zesty herb aioli.',
      price: 229,
      discountPrice: null,
      comboPrice: 309,
      comboLabel: 'Burger + Seasoned Fries + Sparkling Cola',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/cheese-burger.webp',
      ingredients: ['Golden Crispy Patty', 'Melted Cheddar', 'Pickled Jalapeños', 'Zesty Aioli', 'Toasted Bun'],
      dietaryTags: ['Spicy', 'Vegetarian'],
      customisationOptions: [{ name: 'Cheese', choices: ['Single Cheddar', 'Double Cheddar'] }],
      prepMinutes: 12,
      calories: 560,
      available: true,
      stockStatus: 'in_stock',
      isPopular: true,
      isBestseller: true,
      isNew: false,
      isNewArrival: false,
      isRecommended: true,
      updatedAt: now,
    },
    {
      id: 'choco-frappe-combo',
      name: 'Choco Frappe Combo',
      category: 'Combos',
      subcategory: 'Meal Combos',
      showcaseSection: 'Signature Menu',
      description: 'Signature crispy burger paired with a rich, chilled dark chocolate espresso frappe.',
      price: 349,
      discountPrice: null,
      comboPrice: null,
      comboLabel: '',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/cold-coffee.webp',
      ingredients: ['Crispy Burger', 'Dark Cocoa Blend', 'Chilled Milk', 'Espresso Shot', 'Whipped Cream'],
      dietaryTags: ['Combo', 'Vegetarian'],
      customisationOptions: [],
      prepMinutes: 14,
      calories: 780,
      available: true,
      stockStatus: 'in_stock',
      isPopular: true,
      isBestseller: true,
      isNew: false,
      isNewArrival: false,
      isRecommended: true,
      updatedAt: now,
    },
    {
      id: 'piri-piri-fries-meal',
      name: 'Piri Piri Fries Meal',
      category: 'Combos',
      subcategory: 'Meal Combos',
      showcaseSection: 'Signature Menu',
      description: 'Classic crispy burger served with golden shoestring fries and house piri piri spice dust.',
      price: 369,
      discountPrice: null,
      comboPrice: null,
      comboLabel: '',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/cheese-burger.webp',
      ingredients: ['Crispy Burger', 'Russet Fries', 'Piri Piri Spice', 'Garlic Dip'],
      dietaryTags: ['Spicy', 'Combo', 'Vegetarian'],
      customisationOptions: [],
      prepMinutes: 14,
      calories: 820,
      available: true,
      stockStatus: 'in_stock',
      isPopular: true,
      isBestseller: true,
      isNew: false,
      isNewArrival: false,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'korean-spicy-duo',
      name: 'Korean Spicy Duo',
      category: 'Combos',
      subcategory: 'Sharing Combos',
      showcaseSection: 'Signature Menu',
      description: 'Two fiery gochujang-glazed crispy burgers with seasoned fries and sparkling cooler.',
      price: 499,
      discountPrice: null,
      comboPrice: null,
      comboLabel: '',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/korean-burger.webp',
      ingredients: ['Double Crispy Burgers', 'Gochujang Glaze', 'Sesame Slaw', 'Seasoned Fries', 'Citrus Cooler'],
      dietaryTags: ['Spicy', 'Sharing', 'Vegetarian'],
      customisationOptions: [],
      prepMinutes: 16,
      calories: 1090,
      available: true,
      stockStatus: 'in_stock',
      isPopular: true,
      isBestseller: true,
      isNew: false,
      isNewArrival: false,
      isRecommended: true,
      updatedAt: now,
    },
    {
      id: 'classic-crispy-burger',
      name: 'Classic Crispy Burger',
      category: 'Burgers',
      subcategory: 'Artisan Burgers',
      showcaseSection: 'Signature Menu',
      description: 'Crunchy herb-seasoned patty layered with crisp iceberg lettuce and creamy house mayo.',
      price: 219,
      discountPrice: null,
      comboPrice: 299,
      comboLabel: 'Burger + Piri Fries + House Dip',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/cheese-burger.webp',
      ingredients: ['Herb-Seasoned Patty', 'Iceberg Lettuce', 'Creamy Mayo', 'Sesame Bun'],
      dietaryTags: ['Classic', 'Vegetarian'],
      customisationOptions: [],
      prepMinutes: 10,
      calories: 510,
      available: true,
      stockStatus: 'in_stock',
      isPopular: true,
      isBestseller: true,
      isNew: false,
      isNewArrival: false,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'artisan-brioche-burger',
      name: 'Artisan Brioche Burger',
      category: 'Burgers',
      subcategory: 'Artisan Burgers',
      showcaseSection: 'Signature Menu',
      description: 'Herb-crusted patty on toasted sesame brioche served with roasted fries and marinated olives.',
      price: 399,
      discountPrice: null,
      comboPrice: 469,
      comboLabel: 'Brioche Burger + Iced Latte',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/cheese-burger.webp',
      ingredients: ['Artisan Patty', 'Toasted Sesame Brioche', 'Caramelized Onions', 'Roasted Fries', 'Olives'],
      dietaryTags: ['Chef Special', 'Vegetarian'],
      customisationOptions: [],
      prepMinutes: 15,
      calories: 690,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: true,
      isDailySpecial: true,
      dailySpecialPrice: 339,
      dailySpecialStartedAt: now,
      dailySpecialExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: now,
    },
    {
      id: 'crispy-masala-dosa',
      name: 'Crispy Masala Dosa',
      category: 'Chef Specials',
      subcategory: 'South Indian Classics',
      showcaseSection: 'Signature Menu',
      description: 'Golden fermented crepe stuffed with spiced potato masala, coconut chutney, and lentil sambar.',
      price: 279,
      discountPrice: null,
      comboPrice: 349,
      comboLabel: 'Masala Dosa + Cardamom Masala Chai',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/masala-dosa.webp',
      ingredients: ['Fermented Rice-Lentil Batter', 'Spiced Potato Masala', 'Coconut Chutney', 'Sambar'],
      dietaryTags: ['Vegetarian', 'Gluten-Free'],
      customisationOptions: [],
      prepMinutes: 14,
      calories: 440,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: true,
      updatedAt: now,
    },
    {
      id: 'smoky-paneer-sizzler',
      name: 'Smoky Paneer Sizzler',
      category: 'Chef Specials',
      subcategory: 'Sizzlers',
      showcaseSection: 'Signature Menu',
      description: 'Char-grilled cottage cheese over wok-tossed noodles, blistered veggies, and crispy fries.',
      price: 489,
      discountPrice: null,
      comboPrice: 549,
      comboLabel: 'Paneer Sizzler + Chilled Sparkling Cola',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/paneer-sizzler.webp',
      ingredients: ['Char-Grilled Paneer', 'Wok Noodles', 'Bell Peppers', 'Herb Pepper Sauce', 'Crispy Fries'],
      dietaryTags: ['Vegetarian', 'High-Protein'],
      customisationOptions: [],
      prepMinutes: 18,
      calories: 740,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: true,
      updatedAt: now,
    },
    {
      id: 'healthy-protein-bowl',
      name: 'Healthy Protein Bowl',
      category: 'Healthy Bowls',
      subcategory: 'Power Bowls',
      showcaseSection: 'Signature Menu',
      description: 'Grilled paneer cubes with shelled edamame, sweet corn, heirloom tomatoes, and crisp greens.',
      price: 349,
      discountPrice: null,
      comboPrice: 419,
      comboLabel: 'Protein Bowl + 18-Hour Cold Brew',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/protein-bowl.webp',
      ingredients: ['Grilled Paneer', 'Edamame', 'Sweet Corn', 'Cherry Tomatoes', 'Baby Spinach', 'Lemon Vinaigrette'],
      dietaryTags: ['Vegetarian', 'Gluten-Free', 'High-Protein'],
      customisationOptions: [],
      prepMinutes: 11,
      calories: 410,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'masala-puff-chai',
      name: 'Masala Puff & Chai',
      category: 'Café & Bakery',
      subcategory: 'Savory Tea Pairings',
      showcaseSection: 'Signature Menu',
      description: 'Flaky spiced puff pastries paired with a steaming cup of cardamom-ginger masala chai.',
      price: 199,
      discountPrice: null,
      comboPrice: null,
      comboLabel: '',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/chai-snacks.webp',
      ingredients: ['Flaky Puff Pastry', 'Spiced Vegetable Filling', 'Assam Tea', 'Cardamom', 'Fresh Ginger'],
      dietaryTags: ['Vegetarian'],
      customisationOptions: [],
      prepMinutes: 8,
      calories: 380,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'methi-thepla-chai',
      name: 'Methi Thepla & Chai',
      category: 'Café & Bakery',
      subcategory: 'Gujarati Café Bites',
      showcaseSection: 'Signature Menu',
      description: 'Warm fenugreek flatbread rolls served with tangy mango chundo and spiced house chai.',
      price: 179,
      discountPrice: null,
      comboPrice: null,
      comboLabel: '',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/chai-snacks.webp',
      ingredients: ['Whole Wheat Flour', 'Fresh Fenugreek Leaves', 'Sweet Mango Chundo', 'Masala Chai'],
      dietaryTags: ['Vegetarian'],
      customisationOptions: [],
      prepMinutes: 8,
      calories: 340,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'muffin-cafe-latte',
      name: 'Muffin & Café Latte',
      category: 'Café & Bakery',
      subcategory: 'Breakfast Combos',
      showcaseSection: 'Signature Menu',
      description: 'Toasted English muffin with savory herb patty, golden hash brown, and velvety café latte.',
      price: 319,
      discountPrice: null,
      comboPrice: null,
      comboLabel: '',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/hot-coffee.webp',
      ingredients: ['English Muffin', 'Savory Herb Patty', 'Crispy Hash Brown', 'Steamed Milk', 'Espresso'],
      dietaryTags: ['Breakfast', 'Vegetarian'],
      customisationOptions: [],
      prepMinutes: 10,
      calories: 590,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'choco-brownie-sundae',
      name: 'Choco Brownie Sundae',
      category: 'Desserts',
      subcategory: 'Sundaes',
      showcaseSection: 'Signature Menu',
      description: 'Creamy vanilla bean soft-serve swirled with dark fudge brownie bites and crushed cookies.',
      price: 199,
      discountPrice: null,
      comboPrice: 279,
      comboLabel: 'Brownie Sundae + Double Espresso',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/sundae-cola.webp',
      ingredients: ['Vanilla Bean Soft-Serve', 'Dark Fudge Brownie', 'Crushed Chocolate Cookies', 'Hot Fudge'],
      dietaryTags: ['Vegetarian', 'Sweet'],
      customisationOptions: [],
      prepMinutes: 5,
      calories: 460,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: false,
      updatedAt: now,
    },
    {
      id: 'chilled-sparkling-cola',
      name: 'Chilled Sparkling Cola',
      category: 'Beverages',
      subcategory: 'Coolers',
      showcaseSection: 'Signature Menu',
      description: 'Ice-cold classic sparkling cola poured over crushed ice and fresh zesty lime slices.',
      price: 89,
      discountPrice: null,
      comboPrice: null,
      comboLabel: '',
      dietaryType: 'veg',
      imageUrl: '/src/assets/optimized/sundae-cola.webp',
      ingredients: ['Sparkling Cola', 'Fresh Lime Slices', 'Crushed Ice'],
      dietaryTags: ['Vegan', 'Gluten-Free'],
      customisationOptions: [],
      prepMinutes: 2,
      calories: 140,
      available: true,
      stockStatus: 'in_stock',
      isPopular: false,
      isBestseller: false,
      isNew: true,
      isNewArrival: true,
      isRecommended: false,
      updatedAt: now,
    },
  ];

  return [...baseMenu, ...createCoffeeAndBakeryMenu(now)];
}

export function createSeedInventory() {
  const now = new Date().toISOString();
  return [
    { id: 'inv-brioche', name: 'Sesame Brioche & Burger Buns', sku: 'KRD-101', unit: 'pcs', stockQty: 96, reorderLevel: 30, costPerUnit: 18, linkedDishIds: ['artisan-brioche-burger', 'jalapeno-cheese-burger', 'classic-crispy-burger'], updatedAt: now },
    { id: 'inv-paneer', name: 'Artisanal Paneer Blocks', sku: 'KRD-102', unit: 'kg', stockQty: 18, reorderLevel: 6, costPerUnit: 320, linkedDishIds: ['smoky-paneer-sizzler', 'healthy-protein-bowl'], updatedAt: now },
    { id: 'inv-dosa-batter', name: 'Fermented Dosa Batter', sku: 'KRD-103', unit: 'liters', stockQty: 22, reorderLevel: 8, costPerUnit: 110, linkedDishIds: ['crispy-masala-dosa'], updatedAt: now },
    { id: 'inv-arabica', name: 'Single-Origin Espresso & Coffee Beans', sku: 'KRD-104', unit: 'kg', stockQty: 24, reorderLevel: 5, costPerUnit: 950, linkedDishIds: ['roasted-black-coffee', 'muffin-cafe-latte', 'choco-frappe-combo', 'coffee-espresso', 'coffee-cappuccino', 'coffee-cafe-latte', 'coffee-cold-brew', 'coffee-vietnamese-coffee'], updatedAt: now },
    { id: 'inv-croissant-butter', name: 'Cultured French Butter & Laminated Dough', sku: 'KRD-109', unit: 'pcs', stockQty: 84, reorderLevel: 24, costPerUnit: 45, linkedDishIds: ['croissant-classic-butter', 'croissant-chocolate', 'croissant-almond', 'croissant-pistachio', 'croissant-nutella', 'croissant-strawberry', 'croissant-blueberry', 'croissant-cheese', 'croissant-garlic', 'croissant-cream-cheese', 'croissant-chicken', 'croissant-mushroom'], updatedAt: now },
    { id: 'inv-crispy-patty', name: 'Signature Herb Crispy Patties', sku: 'KRD-105', unit: 'pcs', stockQty: 110, reorderLevel: 35, costPerUnit: 42, linkedDishIds: ['crispy-grill-wrap', 'jalapeno-cheese-burger', 'classic-crispy-burger', 'korean-spicy-duo'], updatedAt: now },
    { id: 'inv-piri-fries', name: 'Shoestring Potatoes & Piri Blend', sku: 'KRD-106', unit: 'kg', stockQty: 14, reorderLevel: 10, costPerUnit: 140, linkedDishIds: ['piri-piri-fries-meal', 'artisan-brioche-burger', 'smoky-paneer-sizzler'], updatedAt: now },
    { id: 'inv-chai-pastry', name: 'Assam Tea & Puff Pastry Sheets', sku: 'KRD-107', unit: 'packs', stockQty: 9, reorderLevel: 10, costPerUnit: 180, linkedDishIds: ['masala-puff-chai', 'methi-thepla-chai', 'bakery-danish-pastry'], updatedAt: now },
    { id: 'inv-fudge-dairy', name: 'Belgian Chocolate, Mascarpone & Creams', sku: 'KRD-108', unit: 'liters', stockQty: 18, reorderLevel: 5, costPerUnit: 340, linkedDishIds: ['choco-brownie-sundae', 'choco-frappe-combo', 'bakery-tiramisu', 'bakery-cheesecake', 'bakery-brownies'], updatedAt: now },
  ];
}

export function createSeedReviews() {
  return [
    {
      id: 'rev-1',
      userId: 'seed-guest-1',
      authorName: 'Ananya Verma',
      rating: 5,
      comment: 'The Smoky Paneer Sizzler arrived piping hot with unforgettable char. Our favorite dinner spot in Ahmedabad!',
      dishId: 'smoky-paneer-sizzler',
      createdAt: '2026-11-10T18:30:00.000Z',
    },
    {
      id: 'rev-2',
      userId: 'seed-guest-2',
      authorName: 'Rohan Desai',
      rating: 5,
      comment: 'Crispy Masala Dosa paired with freshly pulled Espresso and a warm Classic Butter Croissant is unbeatable.',
      dishId: 'crispy-masala-dosa',
      createdAt: '2026-11-12T10:15:00.000Z',
    },
    {
      id: 'rev-3',
      userId: 'seed-guest-3',
      authorName: 'Meera Joshi',
      rating: 4,
      comment: 'Loved the Korean Spicy Duo and Cinnamon Roll. Wish delivery packaging had extra lime wedges.',
      dishId: 'korean-spicy-duo',
      createdAt: '2026-11-14T20:05:00.000Z',
    },
  ];
}

export function createSeedCustomers() {
  return [
    {
      uid: 'seed-guest-1',
      email: 'ananya.verma@guest.pier25.in',
      displayName: 'Ananya Verma',
      passwordHash: '',
      role: 'customer',
      phone: '+91 98250 11402',
      address: '14 Gulbai Tekra, Navrangpura, Ahmedabad',
      dietaryPreferences: 'Smoky Paneer Sizzler · Pour-Over',
      loyaltyPoints: 1420,
      totalLoyaltyEarned: 1680,
      totalOrders: 24,
      historicalSpent: 16800,
      createdAt: '2026-08-12T10:00:00.000Z',
      updatedAt: '2026-11-15T19:10:00.000Z',
      lastOrderAt: '2026-11-15T19:10:00.000Z',
    },
    {
      uid: 'seed-guest-2',
      email: 'rohan.desai@guest.pier25.in',
      displayName: 'Rohan Desai',
      passwordHash: '',
      role: 'customer',
      phone: '+91 98791 44210',
      address: '78 Sindhu Bhavan Marg, Bodakdev, Ahmedabad',
      dietaryPreferences: 'Crispy Masala Dosa · Cold Brew',
      loyaltyPoints: 980,
      totalLoyaltyEarned: 1290,
      totalOrders: 19,
      historicalSpent: 12900,
      createdAt: '2026-08-24T09:30:00.000Z',
      updatedAt: '2026-11-14T11:20:00.000Z',
      lastOrderAt: '2026-11-14T11:20:00.000Z',
    },
    {
      uid: 'seed-guest-4',
      email: 'kabir.malhotra@guest.pier25.in',
      displayName: 'Kabir Malhotra',
      passwordHash: '',
      role: 'customer',
      phone: '+91 98980 22319',
      address: '42 Prahlad Nagar, Ahmedabad',
      dietaryPreferences: 'Almond Croissant · Double Espresso',
      loyaltyPoints: 865,
      totalLoyaltyEarned: 1045,
      totalOrders: 15,
      historicalSpent: 10450,
      createdAt: '2026-09-05T08:45:00.000Z',
      updatedAt: '2026-11-13T16:40:00.000Z',
      lastOrderAt: '2026-11-13T16:40:00.000Z',
    },
    {
      uid: 'seed-guest-3',
      email: 'meera.joshi@guest.pier25.in',
      displayName: 'Meera Joshi',
      passwordHash: '',
      role: 'customer',
      phone: '+91 97240 67108',
      address: '9 Satellite Road, Ahmedabad',
      dietaryPreferences: 'Korean Spicy Duo · Cinnamon Roll',
      loyaltyPoints: 740,
      totalLoyaltyEarned: 890,
      totalOrders: 13,
      historicalSpent: 8900,
      createdAt: '2026-09-18T14:15:00.000Z',
      updatedAt: '2026-11-14T20:05:00.000Z',
      lastOrderAt: '2026-11-14T20:05:00.000Z',
    },
    {
      uid: 'seed-guest-5',
      email: 'diya.patel@guest.pier25.in',
      displayName: 'Diya Patel',
      passwordHash: '',
      role: 'customer',
      phone: '+91 98245 90311',
      address: '21 CG Road, Ahmedabad',
      dietaryPreferences: 'Healthy Protein Bowl · Iced Latte',
      loyaltyPoints: 615,
      totalLoyaltyEarned: 725,
      totalOrders: 11,
      historicalSpent: 7250,
      createdAt: '2026-10-02T12:00:00.000Z',
      updatedAt: '2026-11-12T13:30:00.000Z',
      lastOrderAt: '2026-11-12T13:30:00.000Z',
    },
    {
      uid: 'seed-guest-6',
      email: 'vikram.nair@guest.pier25.in',
      displayName: 'Vikram Nair',
      passwordHash: '',
      role: 'customer',
      phone: '+91 99099 54321',
      address: '55 Thaltej Cross Road, Ahmedabad',
      dietaryPreferences: 'Artisan Brioche Burger · Cold Coffee',
      loyaltyPoints: 490,
      totalLoyaltyEarned: 580,
      totalOrders: 9,
      historicalSpent: 5800,
      createdAt: '2026-10-19T18:00:00.000Z',
      updatedAt: '2026-11-11T21:15:00.000Z',
      lastOrderAt: '2026-11-11T21:15:00.000Z',
    },
  ];
}

export function getLoyaltyTier(totalLoyaltyEarned = 0) {
  const pts = Number(totalLoyaltyEarned || 0);
  if (pts >= 1000) return 'Grand Reserve';
  if (pts >= 600) return 'Gold Circle';
  if (pts >= 300) return 'Forest Patron';
  return 'Club Guest';
}

export function createSeedStaff() {
  return [
    { id: 'stf-1', name: 'Krishna Ladva', role: 'Owner & Executive Chef', shift: 'Full Day (10:00 – 22:30)', email: OWNER_EMAIL, status: 'active' },
    { id: 'stf-2', name: 'Aarav Mehta', role: 'Head Sous Chef', shift: 'Evening (14:00 – 23:00)', email: 'aarav.kitchen@pier25.local', status: 'active' },
    { id: 'stf-3', name: 'Priya Nair', role: 'Front-of-House Manager', shift: 'Split (11:00 – 21:00)', email: 'priya.foh@pier25.local', status: 'active' },
    { id: 'stf-4', name: 'Kabir Shah', role: 'Lead Barista & Viennoiserie Chef', shift: 'Morning (08:00 – 17:00)', email: 'kabir.cafe@pier25.local', status: 'active' },
  ];
}

export function createDefaultSettings() {
  return {
    restaurantName: 'Pier 25',
    tagline: 'Artisanal Coffee, Hand-Laminated Croissants & Culinary Intelligence.',
    email: OWNER_EMAIL,
    phone: '+91 79 4000 8425',
    address: '25 Heritage Courtyard, Navrangpura, Ahmedabad',
    openingHours: 'Daily · 08:00 AM – 11:00 PM',
    currency: 'INR',
    currencySymbol: '₹',
    taxRate: 0.05,
    deliveryFee: 40,
    freeDeliveryThreshold: 499,
    loyaltyPointsPerRupee: 0.1,
    acceptingOrders: true,
    acceptingReservations: true,
  };
}

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function getEffectiveDishPrice(dish, pricingMode = 'individual', nowMs = Date.now()) {
  if (pricingMode === 'combo') {
    const combo = Number(dish?.comboPrice);
    if (Number.isFinite(combo) && combo > 0) {
      return roundMoney(combo);
    }
    return null;
  }
  const base = Number(dish?.price);
  if (!Number.isFinite(base) || base <= 0) return null;
  if (isDailySpecialActive(dish, nowMs)) {
    return roundMoney(Number(dish.dailySpecialPrice));
  }
  const discount = Number(dish?.discountPrice);
  if (Number.isFinite(discount) && discount > 0 && discount < base) {
    return roundMoney(discount);
  }
  return roundMoney(base);
}

export function calculateCartTotals(
  rawItems,
  menuItems,
  {
    orderType = 'delivery',
    promoCode = '',
    redeemPoints = 0,
    availablePoints = 0,
    settings = createDefaultSettings(),
  } = {}
) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('Your cart is empty.');
  }
  const menuMap = new Map(menuItems.map((m) => [m.id, m]));
  const lineItems = [];
  let subtotal = 0;
  let itemCount = 0;

  for (const entry of rawItems) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const qty = Number(entry?.quantity);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw new Error('Invalid item quantity in cart.');
    }
    const dish = menuMap.get(id);
    if (!dish) {
      throw new Error(`Dish "${id}" was not found on the menu.`);
    }
    if (dish.available === false || dish.stockStatus === 'out_of_stock') {
      throw new Error(`"${dish.name}" is currently unavailable.`);
    }

    const pricingMode = entry?.pricingMode === 'combo' ? 'combo' : 'individual';
    if (pricingMode === 'combo' && getEffectiveDishPrice(dish, 'combo') === null) {
      throw new Error(`Combo pricing is not available for "${dish.name}".`);
    }
    const unitPrice = getEffectiveDishPrice(dish, pricingMode);
    if (unitPrice === null) {
      throw new Error(`Price for "${dish.name}" has not been set by the restaurant owner yet.`);
    }

    const customisations = entry?.customisations && typeof entry.customisations === 'object' ? entry.customisations : null;
    const customisationSummary = customisations
      ? Object.entries(customisations)
          .filter(([, val]) => String(val || '').trim())
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ')
      : '';

    const lineTotal = roundMoney(unitPrice * qty);
    subtotal = roundMoney(subtotal + lineTotal);
    itemCount += qty;
    lineItems.push({
      id: dish.id,
      name: pricingMode === 'combo' ? `${dish.name} (Combo)` : dish.name,
      pricingMode,
      ...(pricingMode === 'combo' && dish.comboLabel ? { comboLabel: dish.comboLabel } : {}),
      unitPrice,
      originalPrice: roundMoney(dish.price ?? unitPrice),
      quantity: qty,
      lineTotal,
      imageUrl: dish.imageUrl,
      ...(customisationSummary ? { customisations, customisationSummary } : {}),
    });
  }

  const normalizedPromo = String(promoCode || '').trim().toUpperCase();
  let promoDiscount = 0;
  if (normalizedPromo === 'PIER10' || normalizedPromo === 'KRAZZY10') {
    promoDiscount = roundMoney(subtotal * 0.1);
  } else if (normalizedPromo === 'CHEF100' && subtotal >= 499) {
    promoDiscount = 100;
  }

  // 10 loyalty points = ₹1.00 discount, capped at 50% of subtotal after promo
  const safeAvailable = Math.max(0, Math.floor(Number(availablePoints) || 0));
  const requestedRedeem = Math.max(0, Math.floor(Number(redeemPoints) || 0));
  const usablePoints = Math.min(safeAvailable, requestedRedeem);
  const maxLoyaltyDiscount = roundMoney(Math.max(0, (subtotal - promoDiscount) * 0.5));
  const rawLoyaltyDiscount = roundMoney(usablePoints / 10);
  const loyaltyDiscount = Math.min(rawLoyaltyDiscount, maxLoyaltyDiscount);
  const pointsRedeemed = Math.round(loyaltyDiscount * 10);

  const discountedSubtotal = roundMoney(Math.max(0, subtotal - promoDiscount - loyaltyDiscount));
  const taxRate = Number(settings?.taxRate ?? 0.05);
  const tax = roundMoney(discountedSubtotal * taxRate);

  let deliveryFee = 0;
  if (orderType === 'delivery') {
    const threshold = Number(settings?.freeDeliveryThreshold ?? 499);
    const fee = Number(settings?.deliveryFee ?? 40);
    deliveryFee = subtotal >= threshold ? 0 : roundMoney(fee);
  }

  const total = roundMoney(discountedSubtotal + tax + deliveryFee);
  const pointsPerRupee = Number(settings?.loyaltyPointsPerRupee ?? 0.1);
  const pointsEarned = Math.max(1, Math.round(discountedSubtotal * pointsPerRupee));

  return {
    lineItems,
    itemCount,
    subtotal,
    promoCode: promoDiscount > 0 ? normalizedPromo : '',
    promoDiscount,
    loyaltyDiscount,
    pointsRedeemed,
    tax,
    deliveryFee,
    total,
    pointsEarned,
  };
}

export function verifyPaymentSubmission(payment = {}) {
  const method = String(payment?.method || 'card').trim().toLowerCase();
  if (!['card', 'upi', 'cash_on_delivery'].includes(method)) {
    throw new Error('Unsupported payment method.');
  }

  if (method === 'card') {
    const digits = String(payment?.cardNumber || '').replace(/\D/g, '');
    const expiry = String(payment?.expiry || '').trim();
    const cvv = String(payment?.cvv || '').trim();
    if (digits.length < 12 || digits.length > 19) {
      throw new Error('Please enter a valid 12–19 digit card number.');
    }
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry)) {
      throw new Error('Please enter card expiry in MM/YY format.');
    }
    if (!/^\d{3,4}$/.test(cvv)) {
      throw new Error('Please enter a valid 3 or 4 digit CVV.');
    }
    return {
      verified: true,
      method,
      paymentStatus: 'verified',
      paymentReference: `CARD-${digits.slice(-4)}-${randomBytes(3).toString('hex').toUpperCase()}`,
    };
  }

  if (method === 'upi') {
    const upiId = String(payment?.upiId || '').trim();
    if (!/^[a-zA-Z0-9._\-]{2,}@[a-zA-Z]{2,}$/.test(upiId)) {
      throw new Error('Please enter a valid UPI ID (e.g. name@bank).');
    }
    return {
      verified: true,
      method,
      paymentStatus: 'verified',
      paymentReference: `UPI-${randomBytes(4).toString('hex').toUpperCase()}`,
    };
  }

  return {
    verified: true,
    method: 'cash_on_delivery',
    paymentStatus: 'pending',
    paymentReference: `COD-${randomBytes(4).toString('hex').toUpperCase()}`,
  };
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = scryptSync(String(password), salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return timingSafeEqual(keyBuf, derivedBuf);
}

export function signSessionToken(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function computeAnalyticsSnapshot(store) {
  const orders = store.orders || [];
  const validOrders = orders.filter((o) => o.status !== 'cancelled');
  const totalRevenue = roundMoney(validOrders.reduce((sum, o) => sum + Number(o.total || 0), 0));
  const activeOrders = validOrders.filter((o) => o.status !== 'completed').length;
  const avgOrderValue = validOrders.length > 0 ? roundMoney(totalRevenue / validOrders.length) : 0;

  const dishSales = new Map();
  const categoryRevenue = new Map();
  const menuById = new Map((store.menuItems || []).map((m) => [m.id, m]));

  for (const order of validOrders) {
    for (const line of order.items || []) {
      const existing = dishSales.get(line.id) || { id: line.id, name: line.name, qty: 0, revenue: 0 };
      existing.qty += Number(line.quantity || 0);
      existing.revenue = roundMoney(existing.revenue + Number(line.lineTotal || 0));
      dishSales.set(line.id, existing);

      const menuEntry = menuById.get(line.id);
      const cat = menuEntry?.category || 'Other';
      categoryRevenue.set(cat, roundMoney((categoryRevenue.get(cat) || 0) + Number(line.lineTotal || 0)));
    }
  }

  const topDishes = [...dishSales.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
  const inventoryAlertSummary = buildLowStockNotifications(store.inventory || []);
  const reviews = store.reviews || [];
  const averageRating = reviews.length
    ? roundMoney(reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / reviews.length)
    : 0;

  const reservations = store.reservations || [];
  const upcomingReservations = reservations.filter((r) => r.status === 'confirmed' || r.status === 'seated').length;

  return {
    totalRevenue,
    totalOrders: validOrders.length,
    cancelledOrders: orders.length - validOrders.length,
    activeOrders,
    avgOrderValue,
    upcomingReservations,
    totalReservations: reservations.length,
    totalCustomers: (store.users || []).filter((u) => u.role === 'customer').length,
    averageRating,
    reviewCount: reviews.length,
    lowStockCount: inventoryAlertSummary.totalAlertCount,
    lowStockActiveCount: inventoryAlertSummary.activeAlertCount,
    lowStockCriticalCount: inventoryAlertSummary.criticalCount,
    lowStockItems: inventoryAlertSummary.allAlerts,
    inventoryAlertSummary,
    topDishes,
    categoryBreakdown: [...categoryRevenue.entries()].map(([category, revenue]) => ({ category, revenue })),
    menuCount: (store.menuItems || []).length,
  };
}

export class RestaurantStore {
  constructor(filePath = resolve(process.cwd(), 'data', 'store.json')) {
    this.filePath = filePath;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
      let migrated = false;
      const existingIds = new Set((this.data.menuItems || []).map((m) => m.id));
      for (const cafeItem of createCoffeeAndBakeryMenu()) {
        if (!existingIds.has(cafeItem.id)) {
          this.data.menuItems.push(cafeItem);
          migrated = true;
        }
      }
      const seedById = new Map(createSeedMenu().map((s) => [s.id, s]));
      const legacyImagePattern = /^(mc\d+\.(png|jpg)|burger\.jpg|dosa\.jpg|sizzlers\.jpg|dish\.png|m\d+\.png|coca\.jpg|\/src\/assets\/images\/.*)$/;
      const hasDailySpecialField = (this.data.menuItems || []).some((m) => m.isDailySpecial !== undefined);
      for (const item of this.data.menuItems || []) {
        const seedMatch = seedById.get(item.id);
        if (seedMatch) {
          if (!item.imageUrl || legacyImagePattern.test(item.imageUrl)) {
            item.imageUrl = seedMatch.imageUrl;
            migrated = true;
          }
          if (item.comboPrice === undefined) {
            item.comboPrice = seedMatch.comboPrice ?? null;
            item.comboLabel = seedMatch.comboLabel ?? '';
            migrated = true;
          }
          if (!hasDailySpecialField && seedMatch.isDailySpecial) {
            item.isDailySpecial = true;
            item.dailySpecialPrice = seedMatch.dailySpecialPrice;
            item.dailySpecialStartedAt = new Date().toISOString();
            item.dailySpecialExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            migrated = true;
          }
        }
        if (item.isDailySpecial === undefined) {
          item.isDailySpecial = false;
          item.dailySpecialPrice = null;
          item.dailySpecialStartedAt = null;
          item.dailySpecialExpiresAt = null;
          migrated = true;
        }
      }
      if (!this.data.settings?.currencySymbol || String(this.data.settings?.restaurantName || '').includes('KRAZZY')) {
        this.data.settings = { ...createDefaultSettings(), ...this.data.settings, restaurantName: 'Pier 25', currency: 'INR', currencySymbol: '₹' };
        migrated = true;
      }
      for (const stf of this.data.staff || []) {
        if (typeof stf.email === 'string' && stf.email.endsWith('@krazzy.local')) {
          stf.email = stf.email.replace('@krazzy.local', '@pier25.local');
          migrated = true;
        }
      }
      if (!Array.isArray(this.data.users)) {
        this.data.users = [];
        migrated = true;
      }
      if (!this.data.users.some((u) => u.role === 'customer') && (this.data.orders || []).length === 0) {
        this.data.users.push(...createSeedCustomers());
        migrated = true;
      }
      for (const usr of this.data.users) {
        if (usr.totalLoyaltyEarned === undefined) {
          usr.totalLoyaltyEarned = Number(usr.loyaltyPoints || 0);
          migrated = true;
        }
      }
      if (!Array.isArray(this.data.tableSessions)) {
        this.data.tableSessions = [];
        migrated = true;
      }
      if (migrated) await this.persist();
    } catch {
      this.data = {
        sessionSecret: process.env.KRAZZY_SESSION_SECRET || randomBytes(32).toString('hex'),
        users: createSeedCustomers(),
        menuItems: createSeedMenu(),
        orders: [],
        reservations: [],
        tableSessions: [],
        reviews: createSeedReviews(),
        inventory: createSeedInventory(),
        staff: createSeedStaff(),
        newsletterSubscribers: [],
        settings: createDefaultSettings(),
      };
      await this.persist();
    }
    if (!this.data.sessionSecret) {
      this.data.sessionSecret = process.env.KRAZZY_SESSION_SECRET || randomBytes(32).toString('hex');
      await this.persist();
    }
    return this;
  }

  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(() => writeFile(this.filePath, snapshot, 'utf8'));
    return this.writeQueue;
  }

  getSessionSecret() {
    return this.data.sessionSecret;
  }

  sanitizeUser(user) {
    if (!user) return null;
    const loyaltyPoints = Number(user.loyaltyPoints || 0);
    const totalLoyaltyEarned = Math.max(loyaltyPoints, Number(user.totalLoyaltyEarned ?? loyaltyPoints));
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      phone: user.phone || '',
      address: user.address || '',
      dietaryPreferences: user.dietaryPreferences || '',
      loyaltyPoints,
      totalLoyaltyEarned,
      tier: getLoyaltyTier(totalLoyaltyEarned),
      totalOrders: user.totalOrders || 0,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  findUserById(uid) {
    return this.data.users.find((u) => u.uid === uid) || null;
  }

  findUserByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return this.data.users.find((u) => u.email.toLowerCase() === normalized) || null;
  }

  async registerUser({ displayName, email, password, phone = '', address = '' }) {
    const cleanName = String(displayName || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPassword = String(password || '');

    if (cleanName.length < 2 || cleanName.length > 80) {
      throw new Error('Full name must be between 2 and 80 characters.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new Error('Please enter a valid email address.');
    }
    if (cleanPassword.length < 6) {
      throw new Error('Password must be at least 6 characters.');
    }
    if (this.findUserByEmail(cleanEmail)) {
      throw new Error('An account with this email already exists.');
    }

    const now = new Date().toISOString();
    const uid = `usr-${randomBytes(6).toString('hex')}`;
    const role = cleanEmail === OWNER_EMAIL ? 'owner' : 'customer';

    const user = {
      uid,
      email: cleanEmail,
      displayName: cleanName,
      passwordHash: hashPassword(cleanPassword),
      role,
      phone: String(phone || '').slice(0, 30),
      address: String(address || '').slice(0, 240),
      dietaryPreferences: '',
      loyaltyPoints: 50,
      totalLoyaltyEarned: 50,
      totalOrders: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.users.push(user);
    await this.persist();
    return this.sanitizeUser(user);
  }

  async loginUser({ email, password }) {
    const user = this.findUserByEmail(email);
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw new Error('Invalid email or password.');
    }
    if (user.email.toLowerCase() === OWNER_EMAIL && user.role !== 'owner') {
      user.role = 'owner';
      await this.persist();
    }
    return this.sanitizeUser(user);
  }

  async upsertFirebaseUser({ uid, email, displayName, emailVerified }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) throw new Error('Verified email is required.');
    let user = this.data.users.find((u) => u.uid === uid || u.email.toLowerCase() === cleanEmail);
    const now = new Date().toISOString();
    const isOwner = cleanEmail === OWNER_EMAIL && emailVerified === true;

    if (!user) {
      user = {
        uid: uid || `usr-${randomBytes(6).toString('hex')}`,
        email: cleanEmail,
        displayName: String(displayName || cleanEmail.split('@')[0]).slice(0, 80),
        passwordHash: '',
        role: isOwner ? 'owner' : 'customer',
        phone: '',
        address: '',
        dietaryPreferences: '',
        loyaltyPoints: 50,
        totalLoyaltyEarned: 50,
        totalOrders: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.data.users.push(user);
    } else {
      if (isOwner) user.role = 'owner';
      if (displayName) user.displayName = String(displayName).slice(0, 80);
      user.updatedAt = now;
    }
    await this.persist();
    return this.sanitizeUser(user);
  }

  async updateProfile(uid, updates) {
    const user = this.findUserById(uid);
    if (!user) throw new Error('Account not found.');
    if (typeof updates.displayName === 'string' && updates.displayName.trim().length >= 2) {
      user.displayName = updates.displayName.trim().slice(0, 80);
    }
    if (typeof updates.phone === 'string') {
      user.phone = updates.phone.trim().slice(0, 30);
    }
    if (typeof updates.address === 'string') {
      user.address = updates.address.trim().slice(0, 240);
    }
    if (typeof updates.dietaryPreferences === 'string') {
      user.dietaryPreferences = updates.dietaryPreferences.trim().slice(0, 200);
    }
    user.updatedAt = new Date().toISOString();
    await this.persist();
    return this.sanitizeUser(user);
  }

  getMenuWithRatings(nowMs = Date.now()) {
    const reviews = this.data.reviews;
    return this.data.menuItems.map((item) => {
      const dishReviews = reviews.filter((r) => r.dishId === item.id);
      const avg = dishReviews.length
        ? roundMoney(dishReviews.reduce((s, r) => s + r.rating, 0) / dishReviews.length)
        : 4.8;
      const activeSpecial = isDailySpecialActive(item, nowMs);
      return {
        ...item,
        dietaryType: item.dietaryType === 'non-veg' ? 'non-veg' : 'veg',
        stockStatus: STOCK_STATUSES.includes(item.stockStatus)
          ? item.stockStatus
          : item.available === false
            ? 'out_of_stock'
            : 'in_stock',
        isBestseller: Boolean(item.isBestseller ?? item.isPopular),
        isNewArrival: Boolean(item.isNewArrival ?? item.isNew),
        isRecommended: Boolean(item.isRecommended),
        isDailySpecial: Boolean(item.isDailySpecial),
        dailySpecialPrice: item.dailySpecialPrice ?? null,
        dailySpecialStartedAt: item.dailySpecialStartedAt ?? null,
        dailySpecialExpiresAt: item.dailySpecialExpiresAt ?? null,
        isDailySpecialActive: activeSpecial,
        dailySpecialRemainingLabel: activeSpecial ? formatDailySpecialRemaining(item, nowMs) : '',
        dailySpecialSavingsPct: activeSpecial ? computeDailySpecialSavingsPct(item, nowMs) : 0,
        customisationOptions: Array.isArray(item.customisationOptions) ? item.customisationOptions : [],
        rating: avg,
        reviewCount: dishReviews.length,
      };
    });
  }

  async createOrder({ user, items, orderType, tableNumber = '', deliveryAddress, customerName, customerPhone, notes, promoCode, redeemPoints, payment }) {
    if (this.data.settings.acceptingOrders === false) {
      throw new Error('Online ordering is temporarily paused by the kitchen.');
    }

    const cleanName = String(customerName || user?.displayName || '').trim();
    if (cleanName.length < 2) {
      throw new Error('Please provide a customer name for the order.');
    }
    if (!['delivery', 'pickup', 'dine_in'].includes(orderType)) {
      throw new Error('Please select delivery, pickup, or dine-in.');
    }
    if (orderType === 'delivery' && String(deliveryAddress || user?.address || '').trim().length < 5) {
      throw new Error('Please enter a complete delivery address.');
    }

    const availablePoints = user ? user.loyaltyPoints || 0 : 0;
    const totals = calculateCartTotals(items, this.data.menuItems, {
      orderType,
      promoCode,
      redeemPoints,
      availablePoints,
      settings: this.data.settings,
    });

    const paymentResult = verifyPaymentSubmission(payment);
    const now = new Date().toISOString();
    const orderId = `ORD-${randomBytes(3).toString('hex').toUpperCase()}`;

    const cleanTable = orderType === 'dine_in' ? normalizeTableLabel(tableNumber) : '';
    const cleanNotes = String(notes || '').trim();
    const mergedNotes = cleanTable && !cleanNotes.toLowerCase().includes(cleanTable.toLowerCase())
      ? `[${cleanTable}]${cleanNotes ? ` ${cleanNotes}` : ''}`
      : cleanNotes;

    const order = {
      id: orderId,
      userId: user ? user.uid : 'guest',
      customerName: cleanName.slice(0, 80),
      customerEmail: user?.email || '',
      customerPhone: String(customerPhone || user?.phone || '').slice(0, 30),
      orderType,
      tableNumber: cleanTable,
      deliveryAddress: orderType === 'delivery' ? String(deliveryAddress || user?.address || '').trim().slice(0, 240) : '',
      notes: mergedNotes.slice(0, 300),
      items: totals.lineItems,
      itemCount: totals.itemCount,
      subtotal: totals.subtotal,
      promoCode: totals.promoCode,
      promoDiscount: totals.promoDiscount,
      loyaltyDiscount: totals.loyaltyDiscount,
      pointsRedeemed: totals.pointsRedeemed,
      tax: totals.tax,
      deliveryFee: totals.deliveryFee,
      total: totals.total,
      pointsEarned: user ? totals.pointsEarned : 0,
      paymentMethod: paymentResult.method,
      paymentStatus: paymentResult.paymentStatus,
      paymentReference: paymentResult.paymentReference,
      status: 'confirmed',
      estimatedMinutes: Math.max(12, Math.min(45, 10 + totals.itemCount * 3)),
      createdAt: now,
      updatedAt: now,
    };

    const orderedIds = new Map();
    for (const line of totals.lineItems) {
      orderedIds.set(line.id, (orderedIds.get(line.id) || 0) + line.quantity);
    }
    for (const inv of this.data.inventory) {
      let deduction = 0;
      for (const dishId of inv.linkedDishIds || []) {
        if (orderedIds.has(dishId)) {
          deduction += orderedIds.get(dishId);
        }
      }
      if (deduction > 0) {
        inv.stockQty = Math.max(0, roundMoney(inv.stockQty - deduction));
        if (inv.stockQty <= Number(inv.reorderLevel ?? 0)) {
          if (!inv.lowStockAlertAt) inv.lowStockAlertAt = now;
          if (inv.acknowledgedAtStockQty !== undefined && inv.acknowledgedAtStockQty !== null && inv.stockQty < Number(inv.acknowledgedAtStockQty)) {
            delete inv.acknowledgedAtStockQty;
          }
        }
        inv.updatedAt = now;
      }
    }

    if (user) {
      const storedUser = this.findUserById(user.uid);
      if (storedUser) {
        storedUser.loyaltyPoints = Math.max(0, (storedUser.loyaltyPoints || 0) - totals.pointsRedeemed + totals.pointsEarned);
        storedUser.totalLoyaltyEarned = Math.max(
          storedUser.loyaltyPoints,
          Number(storedUser.totalLoyaltyEarned ?? 0) + totals.pointsEarned
        );
        storedUser.totalOrders = (storedUser.totalOrders || 0) + 1;
        storedUser.updatedAt = now;
      }
    }

    this.data.orders.unshift(order);
    if (orderType === 'dine_in' && cleanTable) {
      this._upsertTableSessionInMemory({
        tableLabel: cleanTable,
        user,
        guestName: cleanName,
        source: 'dine_in_order',
        orderId,
        now,
      });
    }
    await this.persist();
    return {
      order,
      user: user ? this.sanitizeUser(this.findUserById(user.uid)) : null,
    };
  }

  _upsertTableSessionInMemory({
    tableLabel,
    user = null,
    guestName = '',
    partySize = null,
    source = 'qr_scanner',
    orderId = '',
    now = new Date().toISOString(),
  }) {
    const meta = findFloorPlanTableMeta(tableLabel);
    if (!meta) {
      throw new Error('Please provide a valid table name (e.g. Table 05).');
    }
    if (!Array.isArray(this.data.tableSessions)) {
      this.data.tableSessions = [];
    }
    const existing = this.data.tableSessions.find(
      (s) => s.id === meta.id || s.tableLabel.toLowerCase() === meta.label.toLowerCase()
    );
    const validSources = ['qr_scanner', 'qr_link', 'owner_manual', 'dine_in_order'];
    const cleanSource = validSources.includes(source) ? source : 'qr_scanner';
    const cleanGuest = String(guestName || user?.displayName || existing?.guestName || 'Walk-In QR Guest')
      .trim()
      .slice(0, 80);
    const cleanPartySize = Number.isFinite(Number(partySize)) && Number(partySize) >= 1
      ? Math.min(20, Math.round(Number(partySize)))
      : (existing?.partySize || meta.seats || 2);

    const activeOrderIds = Array.isArray(existing?.activeOrderIds) ? [...existing.activeOrderIds] : [];
    if (orderId && !activeOrderIds.includes(orderId)) {
      activeOrderIds.unshift(orderId);
    }

    if (existing) {
      Object.assign(existing, {
        tableLabel: meta.label,
        zone: meta.zone,
        seats: meta.seats,
        status: 'occupied',
        source:
          existing.source === 'qr_scanner' && cleanSource === 'dine_in_order'
            ? 'qr_scanner'
            : cleanSource,
        userId: user?.uid || existing.userId || 'guest',
        guestName: cleanGuest,
        partySize: cleanPartySize,
        activeOrderIds,
        updatedAt: now,
      });
      return existing;
    }

    const session = {
      id: meta.id,
      tableLabel: meta.label,
      zone: meta.zone,
      seats: meta.seats,
      status: 'occupied',
      source: cleanSource,
      userId: user?.uid || 'guest',
      guestName: cleanGuest,
      partySize: cleanPartySize,
      activeOrderIds,
      checkedInAt: now,
      updatedAt: now,
    };
    this.data.tableSessions.push(session);
    return session;
  }

  async checkInTable({ tableLabel, user = null, guestName = '', partySize = null, source = 'qr_scanner' } = {}) {
    const now = new Date().toISOString();
    const session = this._upsertTableSessionInMemory({
      tableLabel,
      user,
      guestName,
      partySize,
      source,
      now,
    });
    await this.persist();
    return {
      session,
      floorPlan: this.getFloorPlanState(),
    };
  }

  async releaseTable(tableIdOrLabel) {
    if (!Array.isArray(this.data.tableSessions)) {
      this.data.tableSessions = [];
    }
    const targetId = tableLabelToId(tableIdOrLabel) || String(tableIdOrLabel || '').trim().toLowerCase();
    const idx = this.data.tableSessions.findIndex(
      (s) => s.id === targetId || tableLabelToId(s.tableLabel) === targetId
    );
    let wasOccupied = false;
    if (idx !== -1) {
      this.data.tableSessions.splice(idx, 1);
      wasOccupied = true;
      await this.persist();
    }
    return {
      releasedId: targetId,
      wasOccupied,
      floorPlan: this.getFloorPlanState(),
    };
  }

  getFloorPlanState() {
    const sessions = Array.isArray(this.data.tableSessions) ? this.data.tableSessions : [];
    const activeDineInOrders = (this.data.orders || []).filter(
      (o) => o.orderType === 'dine_in' && !['completed', 'cancelled'].includes(o.status) && o.tableNumber
    );
    const activeReservations = (this.data.reservations || []).filter(
      (r) => ['confirmed', 'seated'].includes(r.status) && r.tableLabel
    );

    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const customTables = [];
    for (const s of sessions) {
      if (!FLOOR_PLAN_TABLES.some((t) => t.id === s.id)) {
        customTables.push({
          id: s.id,
          label: s.tableLabel,
          zone: s.zone || 'Custom Seating',
          seats: Number(s.seats || 4),
          shape: 'square',
          isCustom: true,
        });
      }
    }

    const allTableDefs = [...FLOOR_PLAN_TABLES, ...customTables];
    const tables = allTableDefs.map((def) => {
      const session = sessionById.get(def.id) || null;
      const linkedOrders = activeDineInOrders.filter((o) => tableLabelToId(o.tableNumber) === def.id);
      const linkedReservation =
        activeReservations.find((r) => tableLabelToId(r.tableLabel) === def.id) || null;

      let status = 'available';
      let checkedInViaQr = false;
      let guestName = '';
      let source = '';
      let checkedInAt = null;
      let partySize = def.seats;

      if (session || linkedOrders.length > 0) {
        status = 'occupied';
        source = session?.source || 'dine_in_order';
        checkedInViaQr = source === 'qr_scanner' || source === 'qr_link';
        guestName = session?.guestName || linkedOrders[0]?.customerName || 'Seated Guest';
        checkedInAt = session?.checkedInAt || linkedOrders[0]?.createdAt || null;
        partySize = session?.partySize || def.seats;
      } else if (linkedReservation) {
        status = 'reserved';
        guestName = linkedReservation.name;
        partySize = linkedReservation.partySize;
      }

      return {
        ...def,
        status,
        checkedInViaQr,
        source,
        guestName,
        partySize,
        checkedInAt,
        activeOrders: linkedOrders.map((o) => ({
          id: o.id,
          status: o.status,
          total: o.total,
          itemCount: o.itemCount,
          customerName: o.customerName,
        })),
        reservation: linkedReservation
          ? {
              id: linkedReservation.id,
              name: linkedReservation.name,
              date: linkedReservation.date,
              time: linkedReservation.time,
              partySize: linkedReservation.partySize,
              status: linkedReservation.status,
            }
          : null,
      };
    });

    const occupiedCount = tables.filter((t) => t.status === 'occupied').length;
    const qrCheckedInCount = tables.filter((t) => t.status === 'occupied' && t.checkedInViaQr).length;
    const reservedCount = tables.filter((t) => t.status === 'reserved').length;
    const availableCount = tables.filter((t) => t.status === 'available').length;
    const totalSeats = tables.reduce((s, t) => s + Number(t.seats || 0), 0);
    const occupiedSeats = tables
      .filter((t) => t.status === 'occupied')
      .reduce((s, t) => s + Number(t.seats || 0), 0);

    return {
      tables,
      summary: {
        totalTables: tables.length,
        occupiedCount,
        qrCheckedInCount,
        reservedCount,
        availableCount,
        totalSeats,
        occupiedSeats,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  async updateOrderStatus(orderId, nextStatus, actor) {
    const order = this.data.orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Order not found.');
    if (!ORDER_STATUSES.includes(nextStatus)) {
      throw new Error('Invalid order status.');
    }

    const isOwner = actor?.role === 'owner';
    if (!isOwner) {
      if (!actor || order.userId !== actor.uid) {
        const err = new Error('Forbidden');
        err.statusCode = 403;
        throw err;
      }
      if (nextStatus !== 'cancelled' || ['completed', 'cancelled', 'out_for_delivery'].includes(order.status)) {
        throw new Error('This order can no longer be cancelled online.');
      }
    }

    order.status = nextStatus;
    if (nextStatus === 'cancelled' && order.paymentStatus === 'verified') {
      order.paymentStatus = 'refunded';
    }
    order.updatedAt = new Date().toISOString();
    await this.persist();
    return order;
  }

  async createReservation({ user, name, date, time, partySize, notes = '' }) {
    if (this.data.settings.acceptingReservations === false) {
      throw new Error('Table reservations are currently paused.');
    }
    const validation = validateBooking({ name, date, time, partySize });
    if (!validation.valid) {
      const firstErr = Object.values(validation.errors)[0] || 'Invalid reservation details.';
      const err = new Error(firstErr);
      err.statusCode = 400;
      err.errors = validation.errors;
      throw err;
    }

    const now = new Date().toISOString();
    const reservation = {
      id: `KRZ-${randomBytes(3).toString('hex').toUpperCase()}`,
      userId: user ? user.uid : 'guest',
      customerEmail: user?.email || '',
      name: validation.normalized.name,
      date: validation.normalized.date,
      time: validation.normalized.time,
      partySize: validation.normalized.partySize,
      notes: String(notes || '').trim().slice(0, 300),
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    this.data.reservations.unshift(reservation);
    await this.persist();
    return reservation;
  }

  async updateReservationStatus(id, nextStatus, actor, options = {}) {
    const res = this.data.reservations.find((r) => r.id === id);
    if (!res) throw new Error('Reservation not found.');
    if (nextStatus && !RESERVATION_STATUSES.includes(nextStatus)) {
      throw new Error('Invalid reservation status.');
    }
    const isOwner = actor?.role === 'owner';
    if (!isOwner) {
      if (actor && res.userId !== 'guest' && res.userId !== actor.uid) {
        const err = new Error('Forbidden');
        err.statusCode = 403;
        throw err;
      }
      if (nextStatus !== 'cancelled' || ['completed', 'cancelled'].includes(res.status)) {
        throw new Error('This reservation cannot be modified.');
      }
    }
    if (nextStatus) res.status = nextStatus;
    if (isOwner && options?.tableLabel !== undefined) {
      const cleanTable = normalizeTableLabel(options.tableLabel);
      res.tableLabel = cleanTable || '';
      if (cleanTable && (res.status === 'seated')) {
        this._upsertTableSessionInMemory({
          tableLabel: cleanTable,
          guestName: res.name,
          partySize: res.partySize,
          source: 'owner_manual',
        });
      }
    }
    res.updatedAt = new Date().toISOString();
    await this.persist();
    return res;
  }

  async addReview({ user, authorName, rating, comment, dishId = '' }) {
    const cleanComment = String(comment || '').trim();
    const cleanAuthor = String(authorName || user?.displayName || '').trim();
    const numericRating = Number(rating);

    if (cleanAuthor.length < 2 || cleanAuthor.length > 80) {
      throw new Error('Author name must be between 2 and 80 characters.');
    }
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      throw new Error('Rating must be between 1 and 5 stars.');
    }
    if (cleanComment.length < 3 || cleanComment.length > 500) {
      throw new Error('Review comment must be between 3 and 500 characters.');
    }

    const review = {
      id: `rev-${randomBytes(4).toString('hex')}`,
      userId: user ? user.uid : 'guest',
      authorName: cleanAuthor,
      rating: numericRating,
      comment: cleanComment,
      dishId: String(dishId || '').trim(),
      createdAt: new Date().toISOString(),
    };
    this.data.reviews.unshift(review);

    if (user) {
      const storedUser = this.findUserById(user.uid);
      if (storedUser) {
        storedUser.loyaltyPoints = (storedUser.loyaltyPoints || 0) + 15;
        storedUser.totalLoyaltyEarned = Math.max(
          storedUser.loyaltyPoints,
          Number(storedUser.totalLoyaltyEarned ?? 0) + 15
        );
        storedUser.updatedAt = new Date().toISOString();
      }
    }

    await this.persist();
    return review;
  }

  async deleteReview(id, actor) {
    const idx = this.data.reviews.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error('Review not found.');
    const review = this.data.reviews[idx];
    if (actor?.role !== 'owner' && (!actor || review.userId !== actor.uid)) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    this.data.reviews.splice(idx, 1);
    await this.persist();
    return { deleted: id };
  }

  async upsertMenuItem(payload, existingId = null) {
    const existingItem = existingId ? this.data.menuItems.find((m) => m.id === existingId) : null;
    if (existingId && !existingItem) {
      throw new Error('Menu item not found.');
    }

    const name = payload?.name !== undefined ? String(payload.name).trim() : (existingItem?.name || '');
    const category = payload?.category !== undefined ? String(payload.category).trim() : (existingItem?.category || '');
    const subcategory = payload?.subcategory !== undefined ? String(payload.subcategory).trim().slice(0, 80) : (existingItem?.subcategory || '');
    const showcaseSection = payload?.showcaseSection !== undefined ? String(payload.showcaseSection).trim().slice(0, 80) : (existingItem?.showcaseSection || '');
    const description = payload?.description !== undefined ? String(payload.description).trim() : (existingItem?.description || '');

    let price = existingItem?.price ?? null;
    if (payload?.price !== undefined) {
      if (payload.price === null || payload.price === '') {
        price = null;
      } else {
        const parsed = roundMoney(Number(payload.price));
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100000) {
          throw new Error('Price in ₹ must be between ₹1 and ₹100,000 (or leave blank if pending).');
        }
        price = parsed;
      }
    }

    let discountPrice = existingItem?.discountPrice ?? null;
    if (payload?.discountPrice !== undefined) {
      if (payload.discountPrice === null || payload.discountPrice === '') {
        discountPrice = null;
      } else {
        const parsedDiscount = roundMoney(Number(payload.discountPrice));
        if (!Number.isFinite(parsedDiscount) || parsedDiscount <= 0 || parsedDiscount > 100000) {
          throw new Error('Discount price in ₹ must be a positive amount.');
        }
        if (price !== null && parsedDiscount >= price) {
          throw new Error('Discount price must be lower than the regular ₹ price.');
        }
        discountPrice = parsedDiscount;
      }
    }

    let comboPrice = existingItem?.comboPrice ?? null;
    if (payload?.comboPrice !== undefined) {
      if (payload.comboPrice === null || payload.comboPrice === '') {
        comboPrice = null;
      } else {
        const parsedCombo = roundMoney(Number(payload.comboPrice));
        if (!Number.isFinite(parsedCombo) || parsedCombo <= 0 || parsedCombo > 100000) {
          throw new Error('Combo price in ₹ must be a positive amount (between ₹1 and ₹100,000).');
        }
        comboPrice = parsedCombo;
      }
    }
    const comboLabel = payload?.comboLabel !== undefined
      ? String(payload.comboLabel || '').trim().slice(0, 100)
      : (existingItem?.comboLabel || '');

    const imageUrl = payload?.imageUrl !== undefined
      ? String(payload.imageUrl || '/src/assets/optimized/hot-coffee.webp').trim()
      : (existingItem?.imageUrl || '/src/assets/optimized/hot-coffee.webp');
    const dietaryType = payload?.dietaryType !== undefined
      ? (payload.dietaryType === 'non-veg' ? 'non-veg' : 'veg')
      : (existingItem?.dietaryType || 'veg');

    const ingredients = payload?.ingredients !== undefined
      ? (Array.isArray(payload.ingredients)
          ? payload.ingredients.map((s) => String(s).trim()).filter(Boolean).slice(0, 25)
          : String(payload.ingredients || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25))
      : (existingItem?.ingredients || []);

    const dietaryTags = payload?.dietaryTags !== undefined
      ? (Array.isArray(payload.dietaryTags)
          ? payload.dietaryTags.map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
          : String(payload.dietaryTags || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10))
      : (existingItem?.dietaryTags || []);

    const customisationOptions = payload?.customisationOptions !== undefined
      ? parseCustomisationOptions(payload.customisationOptions)
      : (existingItem?.customisationOptions || []);

    const prepMinutes = payload?.prepMinutes !== undefined
      ? Math.max(1, Math.min(240, Math.round(Number(payload.prepMinutes || 10))))
      : (existingItem?.prepMinutes || 10);
    const calories = payload?.calories !== undefined
      ? Math.max(0, Math.min(5000, Math.round(Number(payload.calories || 250))))
      : (existingItem?.calories || 250);

    let stockStatus = payload?.stockStatus !== undefined
      ? (STOCK_STATUSES.includes(payload.stockStatus) ? payload.stockStatus : 'in_stock')
      : (existingItem?.stockStatus || 'in_stock');

    let available = payload?.available !== undefined ? payload.available !== false : (existingItem?.available !== false);
    if (payload?.stockStatus === 'out_of_stock') {
      available = false;
    } else if (payload?.available === false && payload?.stockStatus === undefined) {
      stockStatus = 'out_of_stock';
    } else if (payload?.available === true && stockStatus === 'out_of_stock' && payload?.stockStatus === undefined) {
      stockStatus = 'in_stock';
    }

    const isBestseller = payload?.isBestseller !== undefined
      ? Boolean(payload.isBestseller)
      : (payload?.isPopular !== undefined ? Boolean(payload.isPopular) : Boolean(existingItem?.isBestseller ?? existingItem?.isPopular));
    const isNewArrival = payload?.isNewArrival !== undefined
      ? Boolean(payload.isNewArrival)
      : (payload?.isNew !== undefined ? Boolean(payload.isNew) : (existingItem ? Boolean(existingItem.isNewArrival ?? existingItem.isNew) : true));
    const isRecommended = payload?.isRecommended !== undefined
      ? Boolean(payload.isRecommended)
      : Boolean(existingItem?.isRecommended);

    if (name.length < 2 || name.length > 100) throw new Error('Food item name must be 2–100 characters.');
    if (category.length < 2 || category.length > 50) throw new Error('Category must be 2–50 characters.');
    if (description.length < 5 || description.length > 500) throw new Error('Description must be 5–500 characters.');

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    let dailySpecialState = {
      isDailySpecial: Boolean(existingItem?.isDailySpecial),
      dailySpecialPrice: existingItem?.dailySpecialPrice ?? null,
      dailySpecialStartedAt: existingItem?.dailySpecialStartedAt ?? null,
      dailySpecialExpiresAt: existingItem?.dailySpecialExpiresAt ?? null,
    };

    if (payload?.isDailySpecial !== undefined) {
      if (!payload.isDailySpecial) {
        dailySpecialState = createDailySpecialWindow({ enabled: false });
      } else {
        const promoCandidate = payload.dailySpecialPrice !== undefined
          ? payload.dailySpecialPrice
          : dailySpecialState.dailySpecialPrice;
        const alreadyActiveSamePrice =
          existingItem &&
          isDailySpecialActive(existingItem, nowMs) &&
          roundMoney(Number(promoCandidate)) === roundMoney(Number(existingItem.dailySpecialPrice)) &&
          !payload.resetDailySpecialWindow;

        if (alreadyActiveSamePrice && price !== null && Number(promoCandidate) < price) {
          dailySpecialState = {
            isDailySpecial: true,
            dailySpecialPrice: existingItem.dailySpecialPrice,
            dailySpecialStartedAt: existingItem.dailySpecialStartedAt,
            dailySpecialExpiresAt: existingItem.dailySpecialExpiresAt,
          };
        } else {
          dailySpecialState = createDailySpecialWindow({
            enabled: true,
            dailySpecialPrice: promoCandidate,
            regularPrice: price,
            durationHours: payload.dailySpecialDurationHours || 24,
            nowMs,
          });
        }
      }
    } else if (dailySpecialState.isDailySpecial && (price === null || Number(dailySpecialState.dailySpecialPrice) >= price)) {
      dailySpecialState = createDailySpecialWindow({ enabled: false });
    }

    if (existingItem) {
      Object.assign(existingItem, {
        name,
        category,
        subcategory,
        showcaseSection,
        description,
        price,
        discountPrice,
        comboPrice,
        comboLabel,
        dietaryType,
        imageUrl,
        ingredients,
        dietaryTags,
        customisationOptions,
        prepMinutes,
        calories,
        available,
        stockStatus,
        isPopular: isBestseller,
        isBestseller,
        isNew: isNewArrival,
        isNewArrival,
        isRecommended,
        ...dailySpecialState,
        updatedAt: now,
      });
      await this.persist();
      return existingItem;
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dish';
    const id = `${slug}-${randomBytes(2).toString('hex')}`;
    const created = {
      id,
      name,
      category,
      subcategory,
      showcaseSection,
      description,
      price,
      discountPrice,
      comboPrice,
      comboLabel,
      dietaryType,
      imageUrl,
      ingredients,
      dietaryTags,
      customisationOptions,
      prepMinutes,
      calories,
      available,
      stockStatus,
      isPopular: isBestseller,
      isBestseller,
      isNew: isNewArrival,
      isNewArrival,
      isRecommended,
      ...dailySpecialState,
      updatedAt: now,
    };
    this.data.menuItems.unshift(created);
    await this.persist();
    return created;
  }

  async setDailySpecial(id, { enabled, dailySpecialPrice, durationHours = 24, nowMs = Date.now() } = {}) {
    const existingItem = this.data.menuItems.find((m) => m.id === id);
    if (!existingItem) throw new Error('Menu item not found.');

    const nextState = createDailySpecialWindow({
      enabled: Boolean(enabled),
      dailySpecialPrice: dailySpecialPrice ?? existingItem.dailySpecialPrice,
      regularPrice: existingItem.price,
      durationHours,
      nowMs,
    });

    Object.assign(existingItem, nextState, {
      updatedAt: new Date(nowMs).toISOString(),
    });
    await this.persist();
    return this.getMenuWithRatings(nowMs).find((m) => m.id === id) || existingItem;
  }

  async deleteMenuItem(id) {
    const idx = this.data.menuItems.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error('Menu item not found.');
    this.data.menuItems.splice(idx, 1);
    await this.persist();
    return { deleted: id };
  }

  async upsertInventoryItem(payload, id = null) {
    const hasName = payload?.name !== undefined;
    const hasSku = payload?.sku !== undefined;
    const hasUnit = payload?.unit !== undefined;
    const name = hasName ? String(payload.name || '').trim() : '';
    const sku = hasSku ? String(payload.sku || '').trim() : `KRD-${randomBytes(2).toString('hex').toUpperCase()}`;
    const unit = hasUnit ? String(payload.unit || 'units').trim() : 'units';
    const stockQty = Math.max(0, Number(payload?.stockQty ?? 0));
    const reorderLevel = Math.max(0, Number(payload?.reorderLevel ?? 10));
    const costPerUnit = roundMoney(Math.max(0, Number(payload?.costPerUnit ?? 1)));
    const linkedDishIds = Array.isArray(payload?.linkedDishIds) ? payload.linkedDishIds : [];
    const now = new Date().toISOString();

    if (id) {
      const existing = this.data.inventory.find((i) => i.id === id);
      if (!existing) throw new Error('Inventory item not found.');
      if (hasName && name) existing.name = name;
      if (hasSku && sku) existing.sku = sku;
      if (hasUnit && unit) existing.unit = unit;
      if (payload?.stockQty !== undefined && Number.isFinite(stockQty)) existing.stockQty = stockQty;
      if (payload?.reorderLevel !== undefined && Number.isFinite(reorderLevel)) existing.reorderLevel = reorderLevel;
      if (payload?.costPerUnit !== undefined && Number.isFinite(costPerUnit)) existing.costPerUnit = costPerUnit;
      if (Array.isArray(payload?.linkedDishIds)) existing.linkedDishIds = linkedDishIds;
      const evalState = evaluateInventoryStock(existing);
      if (evalState.needsReorder) {
        if (!existing.lowStockAlertAt) existing.lowStockAlertAt = now;
        if (existing.acknowledgedAtStockQty !== undefined && existing.stockQty < Number(existing.acknowledgedAtStockQty)) {
          delete existing.acknowledgedAtStockQty;
        }
        if (payload?.reorderLevel !== undefined && existing.stockQty <= existing.reorderLevel) {
          delete existing.acknowledgedAtStockQty;
        }
      } else {
        delete existing.lowStockAlertAt;
        delete existing.acknowledgedAtStockQty;
      }
      existing.updatedAt = now;
      await this.persist();
      return existing;
    }

    if (name.length < 2) throw new Error('Ingredient name is required.');
    const created = {
      id: `inv-${randomBytes(3).toString('hex')}`,
      name,
      sku,
      unit,
      stockQty,
      reorderLevel,
      costPerUnit,
      linkedDishIds,
      ...(stockQty <= reorderLevel ? { lowStockAlertAt: now } : {}),
      updatedAt: now,
    };
    this.data.inventory.unshift(created);
    await this.persist();
    return created;
  }

  async restockInventoryItem(id, addQty = null) {
    const existing = this.data.inventory.find((i) => i.id === id);
    if (!existing) throw new Error('Inventory item not found.');
    const evalBefore = evaluateInventoryStock(existing);
    const delta = addQty !== null && addQty !== undefined && Number.isFinite(Number(addQty)) && Number(addQty) > 0
      ? Number(addQty)
      : Math.max(1, evalBefore.recommendedReorderQty || Math.max(1, existing.reorderLevel));
    const now = new Date().toISOString();
    existing.stockQty = roundMoney(existing.stockQty + delta);
    if (existing.stockQty > Number(existing.reorderLevel ?? 0)) {
      delete existing.lowStockAlertAt;
      delete existing.acknowledgedAtStockQty;
    }
    existing.updatedAt = now;
    await this.persist();
    return {
      item: existing,
      addedQty: delta,
      alertSummary: buildLowStockNotifications(this.data.inventory),
    };
  }

  async acknowledgeInventoryAlert(id) {
    const existing = this.data.inventory.find((i) => i.id === id);
    if (!existing) throw new Error('Inventory item not found.');
    existing.acknowledgedAtStockQty = Number(existing.stockQty || 0);
    existing.updatedAt = new Date().toISOString();
    await this.persist();
    return {
      item: existing,
      alertSummary: buildLowStockNotifications(this.data.inventory),
    };
  }

  async deleteInventoryItem(id) {
    const idx = this.data.inventory.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error('Inventory item not found.');
    this.data.inventory.splice(idx, 1);
    await this.persist();
    return { deleted: id, alertSummary: buildLowStockNotifications(this.data.inventory) };
  }

  async upsertStaffMember(payload, id = null) {
    const name = String(payload?.name || '').trim();
    const role = String(payload?.role || '').trim();
    const shift = String(payload?.shift || 'Full Day').trim();
    const email = String(payload?.email || '').trim();
    const status = payload?.status === 'off_duty' ? 'off_duty' : 'active';
    if (name.length < 2 || role.length < 2) throw new Error('Staff name and role are required.');

    if (id) {
      const existing = this.data.staff.find((s) => s.id === id);
      if (!existing) throw new Error('Staff member not found.');
      Object.assign(existing, { name, role, shift, email, status });
      await this.persist();
      return existing;
    }

    const created = {
      id: `stf-${randomBytes(3).toString('hex')}`,
      name,
      role,
      shift,
      email,
      status,
    };
    this.data.staff.push(created);
    await this.persist();
    return created;
  }

  async deleteStaffMember(id) {
    const idx = this.data.staff.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Staff member not found.');
    this.data.staff.splice(idx, 1);
    await this.persist();
    return { deleted: id };
  }

  async updateSettings(payload) {
    const s = this.data.settings;
    if (typeof payload.restaurantName === 'string' && payload.restaurantName.trim()) {
      s.restaurantName = payload.restaurantName.trim().slice(0, 80);
    }
    if (typeof payload.tagline === 'string') s.tagline = payload.tagline.trim().slice(0, 200);
    if (typeof payload.phone === 'string') s.phone = payload.phone.trim().slice(0, 40);
    if (typeof payload.address === 'string') s.address = payload.address.trim().slice(0, 200);
    if (typeof payload.openingHours === 'string') s.openingHours = payload.openingHours.trim().slice(0, 120);
    if (Number.isFinite(Number(payload.taxRate))) s.taxRate = Math.max(0, Math.min(0.3, Number(payload.taxRate)));
    if (Number.isFinite(Number(payload.deliveryFee))) s.deliveryFee = Math.max(0, Math.min(500, Number(payload.deliveryFee)));
    if (Number.isFinite(Number(payload.freeDeliveryThreshold))) s.freeDeliveryThreshold = Math.max(0, Number(payload.freeDeliveryThreshold));
    if (typeof payload.acceptingOrders === 'boolean') s.acceptingOrders = payload.acceptingOrders;
    if (typeof payload.acceptingReservations === 'boolean') s.acceptingReservations = payload.acceptingReservations;
    await this.persist();
    return s;
  }

  async subscribeNewsletter(email) {
    const clean = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      throw new Error('Please enter a valid email address.');
    }
    if (!this.data.newsletterSubscribers.includes(clean)) {
      this.data.newsletterSubscribers.push(clean);
      await this.persist();
    }
    return { email: clean, subscribed: true };
  }

  getCustomersCRM() {
    return this.data.users
      .filter((u) => u.role === 'customer')
      .map((u) => {
        const userOrders = this.data.orders.filter((o) => o.userId === u.uid && o.status !== 'cancelled');
        const ordersSpent = roundMoney(userOrders.reduce((s, o) => s + Number(o.total || 0), 0));
        const totalSpent = roundMoney(ordersSpent + Number(u.historicalSpent || 0));
        const base = this.sanitizeUser(u);
        return {
          ...base,
          totalSpent,
          lastOrderAt: userOrders[0]?.createdAt || u.lastOrderAt || null,
        };
      })
      .sort((a, b) => {
        if (b.totalLoyaltyEarned !== a.totalLoyaltyEarned) return b.totalLoyaltyEarned - a.totalLoyaltyEarned;
        if (b.totalOrders !== a.totalOrders) return b.totalOrders - a.totalOrders;
        return a.displayName.localeCompare(b.displayName);
      });
  }

  getEliteGuestsLeaderboard({ limit = 6 } = {}) {
    const crmCustomers = this.getCustomersCRM();
    const maxCount = Math.max(1, Math.min(20, Math.round(Number(limit) || 6)));
    const totalPointsAwarded = crmCustomers.reduce((sum, c) => sum + Number(c.totalLoyaltyEarned || 0), 0);

    const guests = crmCustomers.slice(0, maxCount).map((c, idx) => {
      const parts = String(c.displayName || 'Guest').trim().split(/\s+/);
      const initials = parts.length >= 2
        ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
        : String(c.displayName || 'G').slice(0, 2).toUpperCase();

      return {
        rank: idx + 1,
        uid: c.uid,
        displayName: c.displayName,
        initials,
        tier: c.tier || getLoyaltyTier(c.totalLoyaltyEarned),
        totalLoyaltyEarned: Number(c.totalLoyaltyEarned || 0),
        loyaltyPoints: Number(c.loyaltyPoints || 0),
        totalOrders: Number(c.totalOrders || 0),
        favoriteHighlight: c.dietaryPreferences || '',
      };
    });

    return {
      guests,
      totalMembers: crmCustomers.length,
      totalPointsAwarded,
      updatedAt: new Date().toISOString(),
    };
  }

  getLoyaltyAnalytics(options = {}) {
    return computeLoyaltyAnalytics(this.data, options);
  }
}

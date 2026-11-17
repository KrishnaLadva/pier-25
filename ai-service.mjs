import { GoogleGenAI, Type } from '@google/genai';

const MODEL_ID = 'gemini-4-hydrogen';

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    const err = new Error('Gemini AI service is not configured on this server (GEMINI_API_KEY missing).');
    err.statusCode = 503;
    throw err;
  }
  return new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function summarizeMenuForPrompt(menuItems) {
  return menuItems
    .filter((item) => item.available !== false)
    .map((item) => {
      const hasPrice = item.price !== null && item.price !== undefined && Number(item.price) > 0;
      const effectivePrice = hasPrice
        ? (item.discountPrice && Number(item.discountPrice) < Number(item.price)
            ? Number(item.discountPrice)
            : Number(item.price))
        : null;
      return {
        id: item.id,
        name: item.name,
        category: item.category,
        subcategory: item.subcategory || '',
        showcaseSection: item.showcaseSection || '',
        dietaryType: item.dietaryType === 'non-veg' ? 'non-veg' : 'veg',
        priceINR: effectivePrice !== null ? `₹${effectivePrice}` : 'Owner Pricing Pending',
        regularPriceINR: hasPrice ? `₹${Number(item.price)}` : null,
        description: item.description,
        ingredients: item.ingredients || [],
        dietaryTags: item.dietaryTags || [],
        isBestseller: Boolean(item.isBestseller ?? item.isPopular),
        isNewArrival: Boolean(item.isNewArrival ?? item.isNew),
        isRecommended: Boolean(item.isRecommended),
        prepMinutes: item.prepMinutes || 12,
      };
    });
}

function parseJsonSafely(text, fallbackErrorMessage) {
  if (!text || typeof text !== 'string') {
    throw new Error(fallbackErrorMessage);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(fallbackErrorMessage);
  }
}

export async function chatWithConcierge({ message, history = [], menuItems = [], userPreferences = '' }) {
  const ai = getAiClient();
  const menuContext = JSON.stringify(summarizeMenuForPrompt(menuItems));

  const transcript = history
    .slice(-8)
    .map((entry) => `${entry.role === 'user' ? 'Guest' : 'Concierge'}: ${String(entry.text || '').slice(0, 400)}`)
    .join('\n');

  const prompt = [
    transcript ? `Recent conversation:\n${transcript}` : '',
    userPreferences ? `Guest dietary/taste notes: ${userPreferences}` : '',
    `Guest message: ${message}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: prompt,
    config: {
      systemInstruction:
        `You are the Pier 25 AI Food Concierge—warm, culinary-savvy, and concise (under 140 words per reply). Prices are in Indian Rupees (₹); never invent prices for items marked "Owner Pricing Pending". Only recommend dishes/coffees/croissants/desserts that actually exist in the provided live menu JSON. Return structured JSON with a conversational reply and up to 3 recommended dish IDs from the live menu.\n\nLIVE MENU:\n${menuContext}`,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          reply: { type: Type.STRING },
          recommendedIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          followUpPrompt: { type: Type.STRING },
        },
        required: ['reply', 'recommendedIds'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to parse concierge response.');
}

export async function getPersonalizedRecommendations({ preferences, dietaryTags = [], budgetMax, recentDishNames = [], menuItems = [] }) {
  const ai = getAiClient();
  const menuContext = JSON.stringify(summarizeMenuForPrompt(menuItems));

  const prompt = `Guest request/preferences: ${preferences || 'Surprise me with balanced chef, coffee & croissant favorites.'}
Dietary tags requested: ${dietaryTags.length ? dietaryTags.join(', ') : 'None specified'}
Max price budget: ${budgetMax ? `₹${budgetMax}` : 'No strict cap'}
Previously ordered dishes: ${recentDishNames.length ? recentDishNames.join(', ') : 'First-time guest'}

Select 3 to 4 items from the live menu and explain briefly why each suits this guest.`;

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: prompt,
    config: {
      systemInstruction:
        `You are Pier 25's culinary recommendation engine. Select only valid dish IDs from the live menu JSON. Respect ₹ pricing and mention if an item is awaiting owner pricing.\n\nLIVE MENU:\n${menuContext}`,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          headline: { type: Type.STRING },
          recommendations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                reason: { type: Type.STRING },
                pairingTip: { type: Type.STRING },
              },
              required: ['id', 'reason'],
            },
          },
        },
        required: ['headline', 'recommendations'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to parse recommendations.');
}

export async function semanticFoodSearch({ query, menuItems = [] }) {
  const ai = getAiClient();
  const menuContext = JSON.stringify(summarizeMenuForPrompt(menuItems));

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: `Search intent: "${query}"`,
    config: {
      systemInstruction:
        `Match the guest's natural-language craving or ingredient/dietary/coffee/croissant query against the live menu JSON. Return matching dish IDs ordered by relevance and a crisp one-sentence summary.\n\nLIVE MENU:\n${menuContext}`,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          matchedIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['summary', 'matchedIds'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to parse semantic search results.');
}

export async function recognizeFoodImage({ base64Data, mimeType, menuItems = [] }) {
  const ai = getAiClient();
  const menuContext = JSON.stringify(summarizeMenuForPrompt(menuItems));

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: mimeType || 'image/jpeg',
            data: base64Data,
          },
        },
        {
          text: 'Identify the food or beverage, key visible ingredients, flavor profile, and match the closest 1-3 items from our live restaurant, coffee & bakery menu.',
        },
      ],
    },
    config: {
      systemInstruction:
        `You are Pier 25's multimodal food recognition assistant. Identify the food in the image accurately and map it to matching IDs from the live menu.\n\nLIVE MENU:\n${menuContext}`,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          detectedDish: { type: Type.STRING },
          flavorProfile: { type: Type.STRING },
          estimatedIngredients: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          matchedIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          matchExplanation: { type: Type.STRING },
        },
        required: ['detectedDish', 'flavorProfile', 'estimatedIngredients', 'matchedIds', 'matchExplanation'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to parse image recognition response.');
}

export async function generateMenuDescription({ name, category, ingredients = [], tone = 'elevated editorial' }) {
  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: `Dish name: ${name}\nCategory: ${category}\nIngredients: ${ingredients.join(', ') || 'chef signature spices'}\nTone: ${tone}`,
    config: {
      systemInstruction:
        'Write an appetizing, concise 1-2 sentence menu description (max 190 chars) and suggest up to 3 concise dietary/flavor tags and prep minutes.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          description: { type: Type.STRING },
          suggestedTags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          suggestedPrepMinutes: { type: Type.INTEGER },
        },
        required: ['description', 'suggestedTags', 'suggestedPrepMinutes'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to generate menu description.');
}

export async function analyzeReviewSentiment({ reviews = [] }) {
  const ai = getAiClient();
  const compact = reviews.slice(0, 40).map((r) => ({
    rating: r.rating,
    author: r.authorName,
    comment: r.comment,
    dishId: r.dishId || null,
  }));

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: `Analyze these restaurant customer reviews:\n${JSON.stringify(compact)}`,
    config: {
      systemInstruction:
        'Provide an accurate, data-grounded sentiment analysis of the provided customer reviews with percentages summing to 100, key praised themes, improvement areas, and concrete owner actions.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          overallSentiment: { type: Type.STRING },
          positivePercent: { type: Type.INTEGER },
          neutralPercent: { type: Type.INTEGER },
          negativePercent: { type: Type.INTEGER },
          topStrengths: { type: Type.ARRAY, items: { type: Type.STRING } },
          improvementAreas: { type: Type.ARRAY, items: { type: Type.STRING } },
          recommendedActions: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['overallSentiment', 'positivePercent', 'neutralPercent', 'negativePercent', 'topStrengths', 'improvementAreas', 'recommendedActions'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to analyze review sentiment.');
}

export async function generatePromoContent({ campaignGoal, targetDish = '', audience = 'local food and coffee lovers', channel = 'Instagram & Email' }) {
  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: `Goal: ${campaignGoal}\nFeatured Dish/Offer: ${targetDish || 'Chef seasonal lineup'}\nAudience: ${audience}\nChannel: ${channel}`,
    config: {
      systemInstruction:
        'Create refined hospitality marketing copy for Pier 25 with a warm, modern culinary voice in INR (₹) context where applicable. Avoid spammy cliches.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          headline: { type: Type.STRING },
          emailSubject: { type: Type.STRING },
          socialCaption: { type: Type.STRING },
          smsSnippet: { type: Type.STRING },
          callToAction: { type: Type.STRING },
        },
        required: ['headline', 'emailSubject', 'socialCaption', 'smsSnippet', 'callToAction'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to generate promotional content.');
}

export async function askBusinessAssistant({ question, analyticsSnapshot }) {
  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: `Restaurant Operational Metrics Snapshot (Currency: INR ₹):\n${JSON.stringify(analyticsSnapshot)}\n\nOwner Question: ${question}`,
    config: {
      systemInstruction:
        'You are the Pier 25 Restaurant Business & Operations Strategist. Ground every insight strictly in the supplied operational metrics snapshot (currency is INR ₹). Be crisp, actionable, and honest when data volume is low.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          answer: { type: Type.STRING },
          keySignals: { type: Type.ARRAY, items: { type: Type.STRING } },
          actionPlan: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['answer', 'keySignals', 'actionPlan'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to parse business assistant response.');
}

export async function forecastDemand({ analyticsSnapshot }) {
  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: `Operational Snapshot (Currency: INR ₹):\n${JSON.stringify(analyticsSnapshot)}`,
    config: {
      systemInstruction:
        'Provide realistic restaurant & café demand forecasting, inventory prep guidance, and peak hour staffing suggestions strictly grounded in the current menu, orders, reservations, and stock levels.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          predictedPeakWindow: { type: Type.STRING },
          highDemandDishes: { type: Type.ARRAY, items: { type: Type.STRING } },
          inventoryAlerts: { type: Type.ARRAY, items: { type: Type.STRING } },
          staffingAdvice: { type: Type.STRING },
        },
        required: ['summary', 'predictedPeakWindow', 'highDemandDishes', 'inventoryAlerts', 'staffingAdvice'],
      },
    },
  });

  return parseJsonSafely(response.text, 'Failed to parse demand forecast.');
}

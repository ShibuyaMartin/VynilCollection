const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    artist: { type: "string", description: "Main artist name as printed on the cover" },
    title: { type: "string", description: "Album title as printed on the cover" },
    year: { type: "string", description: "Release year if visible, otherwise empty" },
    label: { type: "string", description: "Record label if visible, otherwise empty" },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "How confident the identification is. Use low if the image is not an album cover or is unreadable.",
    },
  },
  required: ["artist", "title", "confidence"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const auth = String(req.headers.authorization || "");
  if (!process.env.ADMIN_TOKEN || auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "Invalid admin token" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
  }

  const { image, mediaType } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: "image (base64) is required" });
  }

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        output_config: {
          format: { type: "json_schema", schema: RESULT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType || "image/jpeg",
                  data: image,
                },
              },
              {
                type: "text",
                text: "This is a photo of a vinyl record cover (it may be at an angle, partially covered, or reflective). Identify the artist and the album title exactly as a music database like Discogs would list them. If the photo is not an album cover or is unreadable, set confidence to low.",
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || `Anthropic API responded ${response.status}`;
      return res.status(502).json({ error: message });
    }

    const text = (data.content || []).find((block) => block.type === "text")?.text;
    if (!text) {
      return res.status(502).json({ error: "No identification in model response" });
    }

    return res.status(200).json({ identification: JSON.parse(text) });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Cover identification failed" });
  }
}

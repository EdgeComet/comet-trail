-- Sample rows for local dashboard development.
-- Loaded by `npm run dev:local` into the LOCAL D1 (Miniflare), never the remote DB.
-- Idempotent: wipes the local table first, so every run gives the same dataset.
DELETE FROM crawls;
INSERT INTO crawls (url, status, response_time_ms, title, meta_description, canonical, hreflangs, h1, h2, bot_name, ts) VALUES
  ('https://example.com/',          200,  142, 'Home — Example',     'Welcome to Example.',        'https://example.com/',          '[]', '["Welcome"]',          '["Features","Pricing"]', 'Googlebot',     1748217600000),
  ('https://example.com/pricing',   200,  201, 'Pricing — Example',  'Plans and pricing.',         'https://example.com/pricing',   '[]', '["Pricing"]',          '["Pro","Team"]',         'Googlebot',     1748221200000),
  ('https://example.com/blog/post', 200,  318, 'A post — Example',   'A blog post.',               'https://example.com/blog/post', '[]', '["A post"]',           '[]',                     'GPTBot',        1748224800000),
  ('https://example.com/gone',      404,   88, 'Not found',          NULL,                         NULL,                            '[]', '["404"]',              '[]',                     'Bingbot',       1748228400000),
  ('https://example.com/slow',      200, 1450, 'Slow page',          'This one took a while.',     'https://example.com/slow',      '[]', '["Slow page"]',        '[]',                     'ClaudeBot',     1748232000000);

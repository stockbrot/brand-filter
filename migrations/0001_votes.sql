CREATE TABLE IF NOT EXISTS brands (
  name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 100),
  decision TEXT CHECK(decision IN ('trustworthy', 'fake')),
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS voters (
  id TEXT PRIMARY KEY,
  last_upload INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  voter TEXT NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  brand TEXT NOT NULL REFERENCES brands(name) ON DELETE CASCADE,
  vote TEXT NOT NULL CHECK(vote IN ('trustworthy', 'fake')),
  PRIMARY KEY (voter, brand)
);
CREATE INDEX IF NOT EXISTS votes_brand ON votes(brand, vote);
CREATE INDEX IF NOT EXISTS brands_decision ON brands(decision, name);

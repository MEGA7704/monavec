-- À exécuter UNE SEULE FOIS après 0005. Sauvegarder D1 auparavant.
-- Numéro motif : quatre caractères hexadécimaux uniques (A47F).
-- Pour les anciens motifs, utiliser une permutation injective garantissant l'unicité
-- jusqu'à 65 536 motifs. Les futurs motifs sont tirés aléatoirement côté serveur.
UPDATE solidarity_motifs
SET reference = (SELECT printf('%04X', ((COUNT(*) * 40503 + 17291) % 65536))
                 FROM solidarity_motifs AS older
                 WHERE older.created_at < solidarity_motifs.created_at
                    OR (older.created_at = solidarity_motifs.created_at AND older.id <= solidarity_motifs.id))
WHERE reference IS NULL OR length(reference) <> 4;

-- Rattacher les anciens mouvements au code du motif puis les ordonner par date de saisie.
UPDATE solidarity_contributions
SET reference = (SELECT m.reference FROM solidarity_motifs m
                 WHERE m.id = solidarity_contributions.motif_id)
  || '-' || printf('%03d',
       (SELECT COUNT(*) FROM solidarity_contributions AS earlier
        WHERE earlier.motif_id = solidarity_contributions.motif_id
          AND (earlier.created_at < solidarity_contributions.created_at
               OR (earlier.created_at = solidarity_contributions.created_at
                   AND earlier.id <= solidarity_contributions.id))))
WHERE reference IS NULL OR reference NOT LIKE '____-%';

-- Séquence monotone pour ne jamais réutiliser un numéro après suppression d'un mouvement.
CREATE TABLE IF NOT EXISTS solidarity_movement_sequences (
 motif_id TEXT PRIMARY KEY REFERENCES solidarity_motifs(id),
 last_number INTEGER NOT NULL DEFAULT 0 CHECK(last_number >= 0)
);
INSERT OR IGNORE INTO solidarity_movement_sequences(motif_id,last_number)
SELECT motif_id, COUNT(*)
FROM solidarity_contributions GROUP BY motif_id;

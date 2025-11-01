-- Manual seeding script for the faculty table.
-- Execute on a Neon/PostgreSQL instance connected to this project.
-- It truncates the table and reinserts the default faculty.

BEGIN;

TRUNCATE TABLE faculty RESTART IDENTITY;

INSERT INTO faculty (id, name, role, bio, photo_url, sort_order, is_published) VALUES
  ('8f1a5a3f-6f62-4f7e-835f-b0c39c7314d5', 'Prof. Riccardo Valentini', 'Direttore Scientifico', 'Università della Tuscia - Premio Nobel per la Pace IPCC, esperto internazionale in climate change e carbon cycle', NULL, 1, TRUE),
  ('bbba5d80-4146-41a7-9901-68e53399e988', 'Virgilio Maretto', 'Coordinatore', 'Esperto in sostenibilità e gestione ambientale, consulente strategico per progetti di transizione ecologica', NULL, 2, TRUE),
  ('4f3f3db9-275d-458f-87fe-f1dcac975992', 'Dr.ssa Maria Vincenza Chiriacò', NULL, 'CMCC - Specialista in inventari nazionali delle emissioni e metodologie IPCC per il settore LULUCF', NULL, 3, TRUE),
  ('e36efb7f-0f64-4fda-9d86-7299f46b7959', 'Prof. Emanuele Blasi', NULL, 'Università della Tuscia - Esperto in economia agraria e valutazione economica dei servizi ecosistemici', NULL, 4, TRUE),
  ('66a03466-678f-4d58-9e12-bb412a26b5a4', 'Prof. Tommaso Chiti', NULL, 'Università della Tuscia - Esperto in biogeochemical cycles, soil carbon dynamics e Life Cycle Assessment', NULL, 5, TRUE),
  ('4c2ff796-720c-4ce2-bceb-f2a9c1bb152f', 'Prof. Dario Papale', NULL, 'Università della Tuscia - Specialista in flussi di CO₂, eddy covariance e monitoraggio ecosistemi forestali', NULL, 6, TRUE),
  ('9d29abce-f1f0-4eec-876f-8d4db82fccff', 'Prof. Raffaele Casa', NULL, 'Università della Tuscia - Esperto in agricoltura di precisione, remote sensing e tecnologie per l''agricoltura sostenibile', NULL, 7, TRUE),
  ('916f0d3d-4cb7-4d09-9f31-730ff91bf1ec', 'Prof. Andrea Vannini', NULL, 'Università della Tuscia - Esperto in patologia vegetale e protezione delle colture in sistemi agricoli sostenibili', NULL, 8, TRUE),
  ('a2b0511f-3b43-482e-9e62-5ab57c9d3d48', 'Prof.ssa Anna Barbati', NULL, 'Università della Tuscia - Specialista in gestione forestale sostenibile, servizi ecosistemici e biodiversità forestale', NULL, 9, TRUE),
  ('c71fbdbc-d7af-4dd2-8a21-9f32719ab782', 'Prof. Pier Maria Corona', NULL, 'CREA - Esperto in inventari forestali, dendrometria e gestione sostenibile delle risorse forestali', NULL, 10, TRUE),
  ('6d15c5af-a3d1-4a9e-af02-c1b61f44f0dc', 'Francesco Rutelli', NULL, 'Esperto in politiche ambientali e governance della sostenibilità, ex Ministro per i Beni e le Attività Culturali', NULL, 11, TRUE),
  ('d0dbbe7b-4962-4a57-a6f1-f959c23a5f85', 'Luca Buonocore', NULL, 'Consulente strategico in sostenibilità e carbon management, esperto in mercati dei crediti di carbonio', NULL, 12, TRUE)
ON CONFLICT (id) DO NOTHING;

COMMIT;

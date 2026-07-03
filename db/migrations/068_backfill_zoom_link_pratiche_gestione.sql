UPDATE lessons
SET location_remote = 'https://unitus.zoom.us/j/87293189002?pwd=r8HyJ0MMauAdc0Dn7K9Lm5hWmmyoPZ.1',
    updated_at = NOW()
WHERE id = 'f432172d-8fff-4526-ad9c-cc03186d9dbe'
  AND COALESCE(location_remote, '') = '';

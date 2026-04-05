/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    // --- systems ---
    const systems = new Collection({
      name: "systems",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        {
          name: "name",
          type: "text",
          required: true,
        },
      ],
    });
    app.save(systems);

    // --- spectrums ---
    const spectrums = new Collection({
      name: "spectrums",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        {
          name: "name",
          type: "text",
          required: false,
        },
        {
          name: "host",
          type: "text",
          required: true,
          pattern:
            "^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
        },
        {
          name: "port",
          type: "number",
          required: true,
          min: 1,
          max: 65535,
          onlyInt: true,
        },
      ],
    });
    app.save(spectrums);

    // --- stations ---
    const systemsCol = app.findCollectionByNameOrId("systems");
    const spectrumsCol = app.findCollectionByNameOrId("spectrums");

    const stations = new Collection({
      name: "stations",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        {
          name: "name",
          type: "text",
          required: true,
        },
        {
          name: "system",
          type: "relation",
          required: true,
          collectionId: systemsCol.id,
          maxSelect: 1,
          cascadeDelete: false,
        },
        {
          name: "spectrum",
          type: "relation",
          required: true,
          collectionId: spectrumsCol.id,
          maxSelect: 1,
          cascadeDelete: false,
        },
      ],
    });
    app.save(stations);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("stations"));
    } catch (_) {}
    try {
      app.delete(app.findCollectionByNameOrId("spectrums"));
    } catch (_) {}
    try {
      app.delete(app.findCollectionByNameOrId("systems"));
    } catch (_) {}
  }
);

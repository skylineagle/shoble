/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const stationsCol = app.findCollectionByNameOrId("stations");

    const stationQueries = new Collection({
      name: "station_queries",
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
          name: "station",
          type: "relation",
          required: true,
          collectionId: stationsCol.id,
          maxSelect: 1,
          cascadeDelete: false,
        },
        {
          name: "command_template",
          type: "text",
          required: true,
        },
        {
          name: "parameter_defs",
          type: "json",
          required: false,
        },
        {
          name: "response_schema",
          type: "text",
          required: true,
        },
      ],
    });
    app.save(stationQueries);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("station_queries"));
    } catch (_) {}
  }
);

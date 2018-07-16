[Home](./index) &gt; [@microsoft/node-core-library](./node-core-library.md) &gt; [JsonSchema](./node-core-library.jsonschema.md) &gt; [fromFile](./node-core-library.jsonschema.fromfile.md)

# JsonSchema.fromFile method

Registers a JsonSchema that will be loaded from a file on disk.

**Signature:**
```javascript
static fromFile(filename: string, options?: IJsonSchemaFromFileOptions): JsonSchema;
```
**Returns:** `JsonSchema`

## Remarks

NOTE: An error occurs if the file does not exist; however, the file itself is not loaded or validated until it the schema is actually used.

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  `filename` | `string` |  |
|  `options` | `IJsonSchemaFromFileOptions` |  |

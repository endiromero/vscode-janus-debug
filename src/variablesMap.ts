import { Logger } from 'node-file-log';
import { DebugProtocol } from 'vscode-debugprotocol';
import { cantorPairing, reverseCantorPairing } from './cantor';

const log = Logger.create('VariablesMap');

export type VariablesReference = number;

export class VariablesContainer {
    public contextId: number;
    public variables: DebugProtocol.Variable[];

    constructor(contextId: number) {
        this.contextId = contextId;
        this.variables = [];
    }
}

export class VariablesMap {
    private variablesMap: Map<VariablesReference, VariablesContainer> = new Map();

    /**
     * Generates a unique reference for a variable based on his contextId, frameId and the hashValue of the variables name.
     * @param {number} contextId The context id.
     * @param {number} frameId The frame id.
     * @param {string} variableName The name of the variable.
     * @returns {VariablesReference} A unique variables reference.
     */
    public createReference(contextId: number, frameId: number, variableName: string): VariablesReference {
        if (variableName === '') {
            throw new Error('Variables name cannot be empty.');
        }

        let hash = 0;
        for (let i = 0; i < variableName.length; i++) {
            const charCode = variableName.charCodeAt(i);
            hash = ((hash << 5) - hash) + charCode;
            hash |= 0; // Convert to 32-bit integer
        }

        return cantorPairing(frameId, hash);
    }

    /**
     * Returns all variables with the passed references.
     * @param {VariablesReference} reference Variables reference.
     * @returns {VariablesContainer} The variables container for the given reference.
     */
    public getVariables(reference: VariablesReference): VariablesContainer {
        const variables = this.variablesMap.get(reference);

        if (variables === undefined) {
            throw new Error(`Unable to get variables: No variable with reference ${reference}`);
        } else {
            return variables;
        }
    }

    public setVariables(reference: VariablesReference, container: VariablesContainer) {
        this.variablesMap.set(reference, container);
    }

    /**
     * Creates a variable based on the variableValue passed from the debugger.
     * The created variable(s) will be saved in an variables container in the variables map.
     * @param {string} variablesName The display name of the variable.
     * @param {any} variableValue The value of the variable.
     * @param {number} contextId The context id.
     * @param {number} frameId The frame id.
     * @param {string} [evaluateName] This param is need for evaluate variables that are properties of object or elements of arrays. For this variables we need also the name of their parent to access the value.
     */
    public createVariable(variableName: string, variableValue: any, contextId: number, frameId: number, evaluateName?: string) {
        if (typeof evaluateName === 'undefined') {
            evaluateName = '';
        }

        // log.info(`Creating variable ${variableName} with value ${variableValue}`);
        const variablesContainer: VariablesContainer = this.variablesMap.get(frameId) || new VariablesContainer(contextId);

        // If the container already contains a variable with this name => update
        const variable = this._createVariable(variableName, variableValue, contextId, frameId, evaluateName);

        if (variablesContainer.variables.length > 0) {
            const filterResult = variablesContainer.variables.filter((element) => {
                return element.name === variable.name;
            });

            if (filterResult.length > 0) {
                // Update the entry
                const index = variablesContainer.variables.indexOf(filterResult[0]);
                variablesContainer.variables[index] = variable;
            } else {
                variablesContainer.variables.push(variable);
            }
        } else {
            variablesContainer.variables.push(variable);
        }

        this.variablesMap.set(frameId, variablesContainer);
    }

    /**
     * The main logic for variables creation.
     * This function creates based on the variables type one or more variables and chains them together with the variablesReference-property.
     * @param {string} variablesName The display name of the variable.
     * @param {any} variableValue The value of the variable
     * @param {number} contextId The context id.
     * @param {number} frameId The frame id.
     * @param {string} [evaluateName=variableName] This param is need for evaluate variables that are properties of object or elements of arrays. For this variables we need also the name of their parent to access the value.
     * @returns {Variable} A full qualified variable object
     */
    private _createVariable(variableName: string, variableValue: any, contextId: number, frameId: number, evaluateName?: string): DebugProtocol.Variable {
        if (typeof evaluateName === 'undefined' || evaluateName === '') {
            evaluateName = variableName;
        }

        if (variableValue === '___jsrdbg_undefined___') {
            return {
                name: variableName,
                value: 'undefined',
                type: 'undefined',
                variablesReference: 0,
            };
        }

        if (typeof variableValue === 'object') {

            const result: DebugProtocol.Variable = {
                name: '',
                value: '',
                variablesReference: 0
            };

            if (variableValue.hasOwnProperty('___jsrdbg_function_desc___')) {
                // function

                result.presentationHint = { kind: 'method' };
                result.type = 'function';
                if (variableValue.___jsrdbg_function_desc___.hasOwnProperty('displayName')) {
                    result.name = variableValue.___jsrdbg_function_desc___.displayName;
                }
                if (variableValue.___jsrdbg_function_desc___.hasOwnProperty('parameterNames')) {
                    let parameters = variableValue.___jsrdbg_function_desc___.parameterNames;
                    parameters = parameters.toString().replace(/,/, ', ');
                    result.value = `function (${parameters}) { ... }`;
                }

                return result;
            }

            if (variableValue.hasOwnProperty('length')) {
                // Array

                result.presentationHint = { kind: 'data' };
                result.name = variableName;
                result.type = 'Array';

                if (variableName === 'arguments') {
                    result.presentationHint.visibility = 'internal';
                }

                const elem: string[] = [];
                for (const prop in variableValue) {
                    if (variableValue.hasOwnProperty(prop) && prop !== 'length') {
                        elem.push(`${variableValue[prop].toString()}`);
                    }
                }
                result.value = `length: ${variableValue.length} [${elem.reduce((a, b) => a + ', ' + b)}]`;
                return result;
            }
        }

        // We have to differentiate between primitive types, arrays, objects, and functions.
        switch (typeof variableValue) {
            case 'string':
                return this.createPrimitiveVariable(variableName, variableValue, evaluateName);
            case 'number':
            case 'boolean':
            case 'undefined':
                return this.createPrimitiveVariable(variableName, variableValue, evaluateName);

            case 'object':
                if (variableValue === null) {
                    return this.createPrimitiveVariable(variableName, variableValue, evaluateName);
                } else if (variableValue.hasOwnProperty("length")) {
                    return this.createArrayVariable(variableName, variableValue, contextId, frameId, evaluateName);
                } else {
                    return this.createObjectVariable(variableName, variableValue, contextId, frameId, evaluateName);
                }

            default:
                throw new Error(`Unsupported variables type: ${typeof variableValue}`);
        }
    }

    /**
     * Creates a variable object for primitive types.
     * @param {string} variableName The display name of the variable.
     * @param {any} variableValue The content of the variable.
     * @param {string} evaluateName This param is need for evaluate variables that are properties of object or elements of arrays. For this variables we need also the name of their parent to access the value.
     * @returns {Variable} A full qualified variables object.
     */
    private createPrimitiveVariable(variableName: string, variableValue: any, evaluateName: string): DebugProtocol.Variable {
        if (variableName === '') {
            throw new Error('Variables name cannot be empty.');
        }

        let variableType = typeof variableValue;
        if (variableValue === undefined) {
            variableValue = 'undefined';
            variableType = 'undefined';
        } else if (variableValue === null) {
            variableValue = 'null';
            variableType = 'object';
        } else {
            variableValue = variableValue.toString();
        }

        return {
            name: variableName,
            evaluateName,
            value: variableValue,
            type: variableType,
            variablesReference: 0,
        };
    }

    /**
     * Creates a variable object for array types.
     * @param {string} variableName The display name of the variable.
     * @param {Array.<any>} variableValue The content of the variable.
     * @param {string} evaluateName This param is need for evaluate variables that are properties of object or elements of arrays. For this variables we need also the name of their parent to access the value.
     * @returns {Variable} A full qualified variables object.
     */
    private createArrayVariable(variableName: string, variableValue: any[], contextId: number, frameId: number, evaluateName: string): DebugProtocol.Variable {
        if (variableName === '') {
            throw new Error('Variables name cannot be empty.');
        }

        // Variables container for the entries of the array
        const variablesContainer: VariablesContainer = new VariablesContainer(contextId);

        // Arrays are returned as objects because the debugger represents the array elements as object properties.
        // The debugger also adds a length-property which represents the amount of elements inside the array.
        let index = 0;
        for (const key in variableValue) {
            if (variableValue.hasOwnProperty(key)) {
                const _variableName = (key === 'length') ? 'length' : index.toString();
                const _evaluateName = (key === 'length') ? `${evaluateName}.length` : `${evaluateName}[${index.toString()}]`;

                variablesContainer.variables.push(
                    this._createVariable(_variableName, variableValue[key], contextId, frameId, _evaluateName)
                );

                index++;
            }
        }

        // Create a reference for the variables container and insert it into the variables map
        const reference = this.createReference(contextId, frameId, evaluateName);
        this.variablesMap.set(reference, variablesContainer);

        // Return a variable which refers to this container
        return {
            name: variableName,
            evaluateName,
            type: 'array',
            value: '[Array]',
            variablesReference: reference
        };
    }

    /**
     * Creates a variable object for object types.
     * @param {string} variableName The display name of the variable.
     * @param {any} variableValue The content of the variable.
     * @param {string} evaluateName This param is need for evaluate variables that are properties of object or elements of arrays. For this variables we need also the name of their parent to access the value.
     * @returns {Variable} A full qualified variables object.
     */
    private createObjectVariable(variableName: string, variableValue: any, contextId: number, frameId: number, evaluateName: string): DebugProtocol.Variable {
        if (variableName === '') {
            throw new Error('Variables name cannot be empty.');
        }

        const variablesContainer: VariablesContainer = new VariablesContainer(contextId);

        if (variableValue.hasOwnProperty('___jsrdbg_function_desc___')) {
            // Functions will be recognized as objects because of the way the debugger evaluate functions
            let functionParams = variableValue.___jsrdbg_function_desc___.parameterNames;
            functionParams = functionParams.toString().replace(/,/, ', ');

            return this.createPrimitiveVariable(variableName, 'function (' + functionParams + ') { ... }', `${evaluateName}.${variableName}`);
        } else {
            // Create a new variable for each property on this object and chain them together with the reference property
            for (const key in variableValue) {
                if (variableValue.hasOwnProperty(key)) {
                    variablesContainer.variables.push(
                        this._createVariable(key, variableValue[key], contextId, frameId, `${evaluateName}.${key}`)
                    );
                }
            }
        }

        const reference = this.createReference(contextId, frameId, evaluateName);
        this.variablesMap.set(reference, variablesContainer);

        return {
            name: variableName,
            evaluateName,
            type: 'object',
            value: '[Object]',
            variablesReference: reference
        };
    }
}

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// ─── GPG Key Init (Custom Dynamic Resource) ───────────────────────────────────
//
// Checks if the SSM parameter already exists; if not, generates an ed25519 GPG
// key and stores it as SecureString.  delete() is intentionally a no-op so that
// `pulumi destroy` never removes the private key from SSM.

export interface GpgKeyInitInputs {
    region: string;
    ssmParamName: string;
    maintainerName: string;
    email: string;
}

const gpgKeyInitProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: GpgKeyInitInputs): Promise<pulumi.dynamic.CreateResult> {
        // Pulumi serialises the provider's methods (`toString()`-ed) and
        // re-invokes them in a separate Node context that does NOT inherit
        // the surrounding module's top-level imports. Resolving these via
        // require() inside the function body is the supported way to access
        // dependencies from within a dynamic provider.
        const {
            SSMClient,
            DescribeParametersCommand,
            PutParameterCommand,
        } = require("@aws-sdk/client-ssm");
        const openpgp = require("openpgp");

        const ssm = new SSMClient({ region: inputs.region });

        // Use DescribeParameters to check existence without reading the value,
        // so ssm:GetParameter / kms:Decrypt permissions are not required.
        const described = await ssm.send(new DescribeParametersCommand({
            ParameterFilters: [{ Key: "Name", Values: [inputs.ssmParamName] }],
        }));
        const exists = (described.Parameters?.length ?? 0) > 0;

        if (!exists) {
            const { privateKey } = await openpgp.generateKey({
                type: "ecc",
                curve: "ed25519",
                userIDs: [{ name: inputs.maintainerName, email: inputs.email }],
                passphrase: "",
                format: "armored",
            });

            await ssm.send(new PutParameterCommand({
                Name: inputs.ssmParamName,
                Value: privateKey,
                Type: "SecureString",
                Description: "GPG private key for apt-awscli-v2",
            }));
        }

        return {
            id: inputs.ssmParamName,
            outs: { ssmParamName: inputs.ssmParamName, initialized: true },
        };
    },

    async diff(_id: string, _olds: any, _news: any): Promise<pulumi.dynamic.DiffResult> {
        // Once created, never signal changes — the key lives in SSM.
        return { changes: false };
    },

    async delete(_id: string, _props: any): Promise<void> {
        // Intentionally do not delete the SSM parameter to protect the secret.
    },
};

export class GpgKeyInit extends pulumi.dynamic.Resource {
    constructor(
        name: string,
        args: {
            region: pulumi.Input<string>;
            ssmParamName: pulumi.Input<string>;
            maintainerName: pulumi.Input<string>;
            email: pulumi.Input<string>;
        },
        opts?: pulumi.CustomResourceOptions,
    ) {
        super(gpgKeyInitProvider, name, args, opts);
    }
}

use anyhow::{Context, Result};
use aws_sdk_ssm::Client as SsmClient;
use pgp::composed::{
    ArmorOptions, CleartextSignedMessage, Deserializable, SignedPublicKey, SignedSecretKey,
};
use pgp::types::Password;
use tracing::info;

pub struct Signer {
    secret_key: SignedSecretKey,
}

impl Signer {
    /// Fetch the private key from SSM and construct a Signer
    pub async fn from_ssm(ssm_client: &SsmClient, ssm_param: &str) -> Result<Self> {
        info!("Fetching GPG private key from SSM: {ssm_param}");
        let resp = ssm_client
            .get_parameter()
            .name(ssm_param)
            .with_decryption(true)
            .send()
            .await
            .context("Failed to get SSM parameter")?;
        let pem = resp
            .parameter()
            .and_then(|p| p.value())
            .context("SSM parameter has no value")?;
        let (secret_key, _) =
            SignedSecretKey::from_string(pem).context("Failed to parse GPG private key")?;
        Ok(Self { secret_key })
    }

    /// Clearsign the Release file and generate InRelease
    pub fn clearsign(&self, input_path: &str, output_path: &str) -> Result<()> {
        info!("Clearsigning {input_path} -> {output_path}");
        let input_data = std::fs::read_to_string(input_path)
            .with_context(|| format!("Failed to read {input_path}"))?;
        let signed_msg = CleartextSignedMessage::sign(
            rand::thread_rng(),
            &input_data,
            &*self.secret_key,
            &Password::empty(),
        )
        .context("Failed to clearsign")?;
        let armored = signed_msg
            .to_armored_string(ArmorOptions::default())
            .context("Failed to serialize signed message")?;
        std::fs::write(output_path, armored)
            .with_context(|| format!("Failed to write {output_path}"))
    }

    /// Extract the public key (ASCII armor) from the internal private key
    pub fn public_key_armored(&self) -> Result<String> {
        let public_key: SignedPublicKey = self.secret_key.clone().into();
        public_key
            .to_armored_string(ArmorOptions::default())
            .context("Failed to serialize public key")
    }
}

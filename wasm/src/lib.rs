use wasm_bindgen::prelude::*;
use md5::{Md5, Digest};

const MAX_MATCHES: usize = 10000;
const BUF_SIZE: usize = 10;

#[wasm_bindgen]
pub struct Scanner {
    mask: u128,
    target: u128,
}

#[wasm_bindgen]
impl Scanner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Scanner { mask: 0, target: 0 }
    }

    #[wasm_bindgen]
    pub fn set_mask_and_target(&mut self, mask_hex: &str, target_hex: &str) -> Result<(), String> {
        let m_clean = mask_hex.trim_start_matches("0x");
        let t_clean = target_hex.trim_start_matches("0x");

        if m_clean.len() > 32 || t_clean.len() > 32 {
            return Err("Hex strings must not exceed 32 chars".into());
        }

        let m_padded = format!("{:0<32}", m_clean);
        let t_padded = format!("{:0<32}", t_clean);

        self.mask = u128::from_str_radix(&m_padded, 16).map_err(|_| "Invalid mask")?;
        self.target = u128::from_str_radix(&t_padded, 16).map_err(|_| "Invalid target")?;

        Ok(())
    }

    #[wasm_bindgen]
    pub fn scan_range(&self, start: u32, end: u32) -> Vec<u32> {
        let mut results = Vec::with_capacity(MAX_MATCHES);
        let mask = self.mask;
        let target = self.target;

        let mut buf = [b'0'; BUF_SIZE];
        let mut itoa_buf = itoa::Buffer::new();
        let start_str = itoa_buf.format(start).as_bytes();
        let mut len = start_str.len();
        buf[BUF_SIZE - len..].copy_from_slice(start_str);

        for id in start..end {
            let hash_bytes: [u8; 16] = Md5::digest(&buf[BUF_SIZE - len..]).into();
            let hash_u128 = u128::from_be_bytes(hash_bytes);

            if (hash_u128 & mask) == target {
                results.push(id);
                if results.len() >= MAX_MATCHES {
                    break;
                }
            }

            let mut idx = BUF_SIZE - 1;
            loop {
                if buf[idx] < b'9' {
                    buf[idx] += 1;
                    break;
                } else {
                    buf[idx] = b'0';
                    if idx == BUF_SIZE - len {
                        len += 1;
                        buf[BUF_SIZE - len] = b'1';
                        break;
                    }
                    idx -= 1;
                }
            }
        }
        results
    }
}
